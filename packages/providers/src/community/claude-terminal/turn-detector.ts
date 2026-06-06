/**
 * Turn-completion detection for the claude-terminal provider.
 *
 * The transcript is AUTHORITATIVE: a turn is done when the latest assistant
 * message has a terminal stop_reason and no tool call is still in flight. This
 * signal LAGS the screen (the TUI renders the answer + idle prompt a poll before
 * the transcript flushes usage — Finding 9), so keying on it can never complete
 * a turn early. The screen `working` check is only a secondary guard against the
 * (largely theoretical) case where the transcript shows end_turn while the TUI
 * is still visibly generating.
 *
 * Screen parsing is deliberately minimal and chrome-tolerant: operator plugins,
 * statuslines, and "what's new"/rating panels render on the screen but never
 * reach the transcript, so we never read DATA from the screen — only coarse
 * activity/input-readiness.
 */
import type { TurnSummary } from './transcript';

/**
 * stop_reasons that mean "the assistant is NOT done — more is coming this turn".
 * Everything else (end_turn, stop_sequence, max_tokens, refusal,
 * model_context_window_exceeded, …) ENDS the turn. We blocklist the two
 * continuation reasons rather than allowlist the terminal ones so that a
 * non-`end_turn` finish (e.g. the model hits max_tokens or refuses) completes
 * the turn promptly instead of hanging the poll loop to `turnTimeoutMs`, and so
 * a future terminal reason from the API can't silently reintroduce that hang.
 *
 * - `tool_use`: the model is about to call a tool; a tool_result + continuation
 *   follow. (`openToolUses` also guards this, but the stop_reason can land a
 *   poll before the tool_use block is counted into the summary.)
 * - `pause_turn`: the server paused a long-running turn; Claude Code auto-resumes
 *   and appends more assistant output, so it is not a real turn boundary.
 */
const NON_TERMINAL_STOP_REASONS = new Set(['tool_use', 'pause_turn']);

/** Authoritative turn-end signal, derived purely from the transcript. */
export function isTranscriptTurnComplete(summary: TurnSummary): boolean {
  return (
    summary.sawAssistant &&
    summary.lastAssistantStopReason !== undefined &&
    !NON_TERMINAL_STOP_REASONS.has(summary.lastAssistantStopReason) &&
    summary.openToolUses === 0
  );
}

// terminalcp's rendered `stdout` can include ANSI CSI sequences (it preserves
// colors). Strip them before matching. Built via fromCharCode(27) so the ESC
// (0x1b) never appears as a control character in a regex literal (no-control-regex).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

/**
 * Active-generation markers. Two signals (either suffices):
 * - the "esc to interrupt" hint shown during generation;
 * - a live spinner: a present-participle "…" immediately followed by a running
 *   "(Ns" timer (e.g. "Cultivating… (2s · thinking…)"). The settled state reads
 *   "Cooked for 12s" / "Baked for 3s" — past tense, no "…(Ns" — so it does NOT
 *   match, and a truncated chrome line like "Bug fixes and reliabil…" has no
 *   trailing "(Ns" so it does not match either.
 */
const WORKING = /esc to interrupt|(?:…|\.\.\.)\s*\(\s*\d+\s*s\b/i;

/** An empty input prompt line ("❯" with nothing after it), optionally box-framed. */
const EMPTY_PROMPT = /^[│|\s]*❯\s*$/m;

export interface ScreenActivity {
  /** TUI is actively generating (interrupt hint or live spinner visible). */
  working: boolean;
  /** An empty input prompt is visible and the TUI is not working — ready to type. */
  inputReady: boolean;
}

export function detectScreenActivity(screen: string): ScreenActivity {
  const text = stripAnsi(screen);
  const working = WORKING.test(text);
  const hasEmptyPrompt = EMPTY_PROMPT.test(text);
  return { working, inputReady: hasEmptyPrompt && !working };
}

/**
 * Combined turn-completion check. Transcript-authoritative; the screen only
 * holds completion back while the TUI is visibly still working.
 */
export function isTurnComplete(summary: TurnSummary, screen: string): boolean {
  return isTranscriptTurnComplete(summary) && !detectScreenActivity(screen).working;
}
