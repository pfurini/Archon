import { afterEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageChunk } from '../../types';
import {
  isSyntheticAssistant,
  mapTranscriptLine,
  parseTranscriptLine,
  TranscriptReader,
} from './transcript';

// ── Fixtures (shapes captured from real Claude Code 2.1.166 transcripts) ──────
const assistantText = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello there' }],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 5 },
  },
});
const assistantThinkTool = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'let me think' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        input: { command: 'echo hi' },
      },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 120, output_tokens: 20 },
  },
});
const userToolResult = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi\n' }],
  },
});
const userPrompt = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: 'run the thing' },
});
// Resume-bootstrap synthetic pair Claude Code writes when `claude --resume` boots.
const syntheticUser = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'Continue from where you left off.' }],
  },
});
const syntheticAssistant = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'No response requested.' }],
    model: '<synthetic>',
    stop_reason: 'stop_sequence',
  },
});
// Core turn-boundary marker Claude Code writes once per turn, after the final
// assistant message and any Stop hooks. `sawTurnEnd` keys on this.
const turnDuration = JSON.stringify({
  type: 'system',
  subtype: 'turn_duration',
  durationMs: 95_323,
});

describe('parseTranscriptLine', () => {
  it('parses a JSON object line', () => {
    expect(parseTranscriptLine(assistantText)?.type).toBe('assistant');
  });
  it('returns null for blank and non-JSON', () => {
    expect(parseTranscriptLine('   ')).toBeNull();
    expect(parseTranscriptLine('not json')).toBeNull();
    expect(parseTranscriptLine('42')).toBeNull(); // not an object
  });
});

describe('mapTranscriptLine', () => {
  it('maps assistant text → assistant chunk', () => {
    const m = new Map<string, string>();
    const chunks = mapTranscriptLine(parseTranscriptLine(assistantText)!, m);
    expect(chunks).toEqual([{ type: 'assistant', content: 'Hello there' }]);
  });

  it('maps thinking + tool_use, records id→name, includes toolCallId', () => {
    const m = new Map<string, string>();
    const chunks = mapTranscriptLine(parseTranscriptLine(assistantThinkTool)!, m);
    expect(chunks).toEqual([
      { type: 'thinking', content: 'let me think' },
      {
        type: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'echo hi' },
        toolCallId: 'toolu_1',
      },
    ]);
    expect(m.get('toolu_1')).toBe('Bash');
  });

  it('resolves tool_result name from the recorded tool_use id', () => {
    const m = new Map<string, string>([['toolu_1', 'Bash']]);
    const chunks = mapTranscriptLine(parseTranscriptLine(userToolResult)!, m);
    expect(chunks).toEqual([
      {
        type: 'tool_result',
        toolName: 'Bash',
        toolOutput: 'hi\n',
        toolCallId: 'toolu_1',
      },
    ]);
  });

  it('falls back to "tool" when the tool_use id is unknown', () => {
    const chunks = mapTranscriptLine(parseTranscriptLine(userToolResult)!, new Map());
    expect((chunks[0] as Extract<MessageChunk, { type: 'tool_result' }>).toolName).toBe('tool');
  });

  it('emits nothing for a string user prompt (our own input) and chrome lines', () => {
    expect(mapTranscriptLine(parseTranscriptLine(userPrompt)!, new Map())).toEqual([]);
    expect(mapTranscriptLine({ type: 'attachment' }, new Map())).toEqual([]);
    expect(mapTranscriptLine({ type: 'file-history-snapshot' }, new Map())).toEqual([]);
  });

  it('stringifies array tool_result content by joining text parts', () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'x',
              content: [{ type: 'text', text: 'out' }],
            },
          ],
        },
      })
    )!;
    const chunks = mapTranscriptLine(line, new Map());
    expect((chunks[0] as Extract<MessageChunk, { type: 'tool_result' }>).toolOutput).toBe('out');
  });
});

describe('isSyntheticAssistant', () => {
  it('flags the resume-bootstrap synthetic assistant line', () => {
    expect(isSyntheticAssistant(parseTranscriptLine(syntheticAssistant)!)).toBe(true);
  });
  it('does not flag a real assistant line or a synthetic user line', () => {
    expect(isSyntheticAssistant(parseTranscriptLine(assistantText)!)).toBe(false);
    expect(isSyntheticAssistant(parseTranscriptLine(syntheticUser)!)).toBe(false);
  });
});

describe('TranscriptReader', () => {
  let dir: string;
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  function tmpFile(contents: string): string {
    dir = mkdtempSync(join(tmpdir(), 'archon-transcript-'));
    const p = join(dir, 'session.jsonl');
    writeFileSync(p, contents);
    return p;
  }

  it('returns empty when the transcript file does not exist yet', async () => {
    const reader = new TranscriptReader(join(tmpdir(), 'does-not-exist-xyz.jsonl'));
    const { chunks, summary } = await reader.pull();
    expect(chunks).toEqual([]);
    expect(summary.sawAssistant).toBe(false);
  });

  it('reads complete lines and tracks the turn summary', async () => {
    const p = tmpFile([assistantThinkTool, userToolResult, assistantText].join('\n') + '\n');
    const reader = new TranscriptReader(p);
    const { chunks, summary } = await reader.pull();
    const types = chunks.map(c => c.type);
    expect(types).toEqual(['thinking', 'tool', 'tool_result', 'assistant']);
    expect(summary.lastAssistantStopReason).toBe('end_turn');
    expect(summary.openToolUses).toBe(0); // one tool_use balanced by one tool_result
    expect(summary.model).toBe('claude-sonnet-4-6');
    expect(summary.usage?.output).toBe(25); // 20 + 5 summed across the turn
  });

  it('buffers a partial trailing line until its newline arrives', async () => {
    const p = tmpFile(assistantText + '\n' + assistantThinkTool); // 2nd line has no trailing \n
    const reader = new TranscriptReader(p);
    const first = await reader.pull();
    expect(first.chunks.map(c => c.type)).toEqual(['assistant']); // only the complete line
    expect(first.summary.openToolUses).toBe(0);

    appendFileSync(p, '\n'); // complete the partial line
    const second = await reader.pull();
    expect(second.chunks.map(c => c.type)).toEqual(['thinking', 'tool']);
    expect(second.summary.openToolUses).toBe(1); // tool_use with no result yet
    expect(second.summary.lastAssistantStopReason).toBe('tool_use');
  });

  it('honors a non-zero start offset (resumed session skips prior content)', async () => {
    const prior = assistantText + '\n';
    const p = tmpFile(prior + userToolResult + '\n');
    const reader = new TranscriptReader(p, Buffer.byteLength(prior, 'utf8'));
    const { chunks } = await reader.pull();
    expect(chunks.map(c => c.type)).toEqual(['tool_result']); // prior assistant line skipped
  });

  it('ignores the resume-bootstrap synthetic turn (regression: resume completed early)', async () => {
    // Bootstrap pair present but our prompt not yet answered → turn NOT complete.
    const p = tmpFile([syntheticUser, syntheticAssistant].join('\n') + '\n');
    const reader = new TranscriptReader(p);
    const boot = await reader.pull();
    expect(boot.chunks).toEqual([]); // synthetic content never streamed
    expect(boot.summary.sawAssistant).toBe(false); // synthetic line doesn't count
    expect(boot.summary.lastAssistantStopReason).toBeUndefined(); // its stop_sequence ignored

    // The real answer arrives on a later poll and is what completes the turn.
    appendFileSync(p, assistantText + '\n');
    const answer = await reader.pull();
    expect(answer.chunks).toEqual([{ type: 'assistant', content: 'Hello there' }]);
    expect(answer.summary.sawAssistant).toBe(true);
    expect(answer.summary.lastAssistantStopReason).toBe('end_turn');
  });

  it('sets sawTurnEnd when a turn_duration system line is read (and false before)', async () => {
    const p = tmpFile(assistantText + '\n');
    const reader = new TranscriptReader(p);
    const before = await reader.pull();
    expect(before.summary.sawTurnEnd).toBe(false); // end_turn alone is not the boundary marker

    appendFileSync(p, turnDuration + '\n');
    const after = await reader.pull();
    expect(after.chunks).toEqual([]); // a system line streams no chunks
    expect(after.summary.sawTurnEnd).toBe(true);
    expect(after.summary.lastAssistantStopReason).toBe('end_turn'); // unchanged
  });
});
