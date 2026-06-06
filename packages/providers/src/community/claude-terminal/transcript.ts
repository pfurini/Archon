/**
 * Claude Code session-transcript reader for the claude-terminal provider.
 *
 * Claude Code writes an append-only JSONL transcript per session at
 * `~/.claude/projects/<dashed-cwd>/<session-id>.jsonl`. This module tails that
 * file from a byte offset and maps each line to Archon `MessageChunk`s,
 * mirroring the SDK-event mapping in `claude/provider.ts` (streamClaudeMessages).
 *
 * Why the transcript and not the screen: the rendered TUI carries operator
 * chrome (statusline, plugins, "what's new"/rating panels) that never reaches
 * the transcript, so the transcript is the clean data source. The screen is
 * used only as a coarse idle signal (see turn-detector.ts).
 *
 * The transcript has NO per-turn "result" terminator line — turn completion is
 * decided by turn-detector.ts from the signals this reader exposes
 * (`lastAssistantStopReason`, `openToolUses`) plus the screen.
 */
import { open } from 'node:fs/promises';

import type { MessageChunk, TokenUsage } from '../../types';

/** Cap a tool result like the SDK provider does (claude/provider.ts:583). */
const MAX_TOOL_OUTPUT = 10_000;

/** One content block inside a transcript message. Loosely typed: these are
 *  Claude Code's on-disk shapes, not Archon types. Optional fields cover every
 *  block variant we care about without `any`. */
interface RawBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface RawMessage {
  role?: string;
  content?: RawBlock[] | string;
  model?: string;
  stop_reason?: string | null;
  usage?: RawUsage;
  id?: string;
}

/** A parsed transcript line (only the fields we read). */
export interface ParsedTranscriptLine {
  type?: string;
  message?: RawMessage;
}

/**
 * Claude Code's resume bootstrap writes a synthetic assistant turn when
 * `claude --resume` boots: a `user` "Continue from where you left off." line
 * followed by an `assistant` line with `model: "<synthetic>"`, content
 * "No response requested.", and a terminal `stop_reason` (stop_sequence).
 *
 * These are internal markers, never real model output. They must be ignored, or
 * (a) the synthetic text leaks into the streamed assistant content and (b) the
 * synthetic terminal stop_reason trips turn-completion on the FIRST poll of a
 * resumed turn — before our injected prompt is even answered — so the provider
 * stops the TUI and returns the bootstrap line as the "answer". Real responses
 * always carry a concrete model id, so the `<synthetic>` sentinel is unambiguous.
 */
export function isSyntheticAssistant(line: ParsedTranscriptLine): boolean {
  return line.type === 'assistant' && line.message?.model === '<synthetic>';
}

/** Parse one JSONL line. Returns null for blank/non-JSON lines (never throws). */
export function parseTranscriptLine(raw: string): ParsedTranscriptLine | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value && typeof value === 'object') return value as ParsedTranscriptLine;
    return null;
  } catch {
    return null;
  }
}

/** Coerce a tool_result `content` field into a single string. */
function stringifyToolResult(content: unknown): string {
  let out: string;
  if (typeof content === 'string') {
    out = content;
  } else if (Array.isArray(content)) {
    // Array of blocks, typically [{ type: 'text', text }]. Join text parts.
    out = content
      .map(part => {
        if (part && typeof part === 'object' && 'text' in part) {
          const t = (part as { text?: unknown }).text;
          return typeof t === 'string' ? t : '';
        }
        return typeof part === 'string' ? part : '';
      })
      .join('');
  } else if (content === undefined || content === null) {
    out = '';
  } else {
    out = JSON.stringify(content);
  }
  return out.length > MAX_TOOL_OUTPUT ? `${out.slice(0, MAX_TOOL_OUTPUT)}...` : out;
}

/**
 * Map a parsed transcript line to MessageChunks.
 *
 * `toolNamesById` correlates a `tool_result` (which carries only
 * `tool_use_id`) back to the tool name from the earlier `tool_use` block.
 * The caller owns the map so it persists across lines within a turn.
 */
export function mapTranscriptLine(
  line: ParsedTranscriptLine,
  toolNamesById: Map<string, string>
): MessageChunk[] {
  const chunks: MessageChunk[] = [];
  const content = line.message?.content;
  if (!Array.isArray(content)) return chunks; // string user prompts / chrome lines → nothing

  if (line.type === 'assistant') {
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        chunks.push({ type: 'assistant', content: block.text });
      } else if (
        block.type === 'thinking' &&
        typeof block.thinking === 'string' &&
        block.thinking
      ) {
        chunks.push({ type: 'thinking', content: block.thinking });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        if (typeof block.id === 'string') toolNamesById.set(block.id, block.name);
        chunks.push({
          type: 'tool',
          toolName: block.name,
          toolInput: block.input ?? {},
          ...(typeof block.id === 'string' ? { toolCallId: block.id } : {}),
        });
      }
    }
  } else if (line.type === 'user') {
    for (const block of content) {
      if (block.type === 'tool_result') {
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
        const toolName = (id && toolNamesById.get(id)) || 'tool';
        chunks.push({
          type: 'tool_result',
          toolName,
          toolOutput: stringifyToolResult(block.content),
          ...(id ? { toolCallId: id } : {}),
        });
      }
    }
  }
  return chunks;
}

/**
 * Running summary of the turn so far, derived from assistant lines.
 * `turn-detector.ts` reads these to decide completion.
 */
export interface TurnSummary {
  /** stop_reason of the most recent assistant message (e.g. 'end_turn', 'tool_use'). */
  lastAssistantStopReason?: string;
  /** Model of the most recent assistant message. */
  model?: string;
  /** Aggregated token usage for the turn (output summed; input = latest). */
  usage?: TokenUsage;
  /** tool_use blocks seen minus tool_result blocks seen — >0 means a tool is mid-flight. */
  openToolUses: number;
  /** True once any assistant line has been observed this turn. */
  sawAssistant: boolean;
}

/** Read `path` from `offset` to EOF. Returns '' if the file is missing or hasn't grown. */
async function readFrom(path: string, offset: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return ''; // ENOENT: transcript not written yet (turn 1 before first flush)
  }
  try {
    const { size } = await handle.stat();
    if (size <= offset) return '';
    const buf = Buffer.alloc(size - offset);
    await handle.read(buf, 0, size - offset, offset);
    return buf.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Stateful, offset-based tailer for one session transcript. Construct with the
 * starting byte offset (the file's size at turn start, so a resumed session's
 * prior content is skipped — `--resume` APPENDS to the same file). Call `pull()`
 * on each poll to get newly-flushed chunks and the updated turn summary.
 *
 * Only complete lines (up to the last newline) are consumed; a partial trailing
 * line stays unread until its newline arrives, and the offset only ever advances
 * to a line boundary — which keeps the byte offset on a safe UTF-8 boundary.
 */
export class TranscriptReader {
  private offset: number;
  private readonly toolNamesById = new Map<string, string>();
  private summary: TurnSummary = { openToolUses: 0, sawAssistant: false };

  constructor(
    private readonly path: string,
    startOffset = 0
  ) {
    this.offset = startOffset;
  }

  /** Current byte offset (the end of the last fully-consumed line). */
  get byteOffset(): number {
    return this.offset;
  }

  /** Snapshot of the running turn summary. */
  get turnSummary(): TurnSummary {
    return { ...this.summary };
  }

  /** Read newly-appended complete lines; return mapped chunks + updated summary. */
  async pull(): Promise<{ chunks: MessageChunk[]; summary: TurnSummary }> {
    const data = await readFrom(this.path, this.offset);
    const lastNl = data.lastIndexOf('\n');
    if (lastNl === -1) return { chunks: [], summary: this.turnSummary };

    const complete = data.slice(0, lastNl);
    this.offset += Buffer.byteLength(complete, 'utf8') + 1; // +1 for the consumed '\n'

    const chunks: MessageChunk[] = [];
    for (const rawLine of complete.split('\n')) {
      const parsed = parseTranscriptLine(rawLine);
      if (!parsed) continue;
      // Drop the resume-bootstrap synthetic turn before it can drive either
      // chunk emission or turn-completion (see isSyntheticAssistant).
      if (isSyntheticAssistant(parsed)) continue;
      this.updateSummary(parsed);
      chunks.push(...mapTranscriptLine(parsed, this.toolNamesById));
    }
    return { chunks, summary: this.turnSummary };
  }

  private updateSummary(line: ParsedTranscriptLine): void {
    const content = line.message?.content;
    if (line.type === 'assistant') {
      this.summary.sawAssistant = true;
      if (line.message?.stop_reason)
        this.summary.lastAssistantStopReason = line.message.stop_reason;
      if (line.message?.model) this.summary.model = line.message.model;
      this.accumulateUsage(line.message?.usage);
      if (Array.isArray(content)) {
        for (const block of content) if (block.type === 'tool_use') this.summary.openToolUses++;
      }
    } else if (line.type === 'user' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result' && this.summary.openToolUses > 0)
          this.summary.openToolUses--;
      }
    }
  }

  private accumulateUsage(usage?: RawUsage): void {
    if (!usage) return;
    const prev = this.summary.usage;
    const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : prev?.input;
    const addedOutput = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
    const output = (prev?.output ?? 0) + addedOutput;
    if (input === undefined && output === 0 && !prev) return;
    const next: TokenUsage = { input: input ?? 0, output };
    next.total = next.input + next.output;
    this.summary.usage = next;
  }
}
