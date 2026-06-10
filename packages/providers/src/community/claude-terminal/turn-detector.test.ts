import { describe, expect, it } from 'bun:test';
import type { TurnSummary } from './transcript';
import { detectScreenActivity, isTranscriptTurnComplete, isTurnComplete } from './turn-detector';

function summary(over: Partial<TurnSummary>): TurnSummary {
  return { openToolUses: 0, sawAssistant: true, sawTurnEnd: false, ...over };
}

// Idle screen (settled): past-tense "Cooked for", empty ❯ box, no interrupt hint.
const IDLE_SCREEN = [
  '⏺ PONG',
  '✻ Cooked for 2s',
  '────────────────────────',
  '❯ ',
  '────────────────────────',
  '  Model: Sonnet 4.6 │ Time: 17s (API: 4s)',
].join('\n');

// Working screen: live spinner "… (2s ·" and an interrupt hint; box still shows ❯.
const WORKING_SCREEN = [
  '❯ Run this exact shell command...',
  '✽ Cultivating… (2s · thinking with high effort)',
  '────────────────────────',
  '❯ ',
  '────────────────────────',
  '  esc to interrupt',
].join('\n');

// Trust dialog: no input box yet.
const TRUST_SCREEN = [
  ' Quick safety check: Is this a project you created or one you trust?',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  ' Enter to confirm · Esc to cancel',
].join('\n');

describe('isTranscriptTurnComplete', () => {
  it('true on end_turn with no open tools', () => {
    expect(isTranscriptTurnComplete(summary({ lastAssistantStopReason: 'end_turn' }))).toBe(true);
  });
  it('true on stop_sequence', () => {
    expect(isTranscriptTurnComplete(summary({ lastAssistantStopReason: 'stop_sequence' }))).toBe(
      true
    );
  });
  it('false on tool_use stop', () => {
    expect(isTranscriptTurnComplete(summary({ lastAssistantStopReason: 'tool_use' }))).toBe(false);
  });
  it('false on pause_turn (server resumes a long-running turn)', () => {
    expect(isTranscriptTurnComplete(summary({ lastAssistantStopReason: 'pause_turn' }))).toBe(
      false
    );
  });
  it('true on max_tokens / refusal (non-end_turn finishes must not hang the loop)', () => {
    expect(isTranscriptTurnComplete(summary({ lastAssistantStopReason: 'max_tokens' }))).toBe(true);
    expect(isTranscriptTurnComplete(summary({ lastAssistantStopReason: 'refusal' }))).toBe(true);
  });
  it('true on an unknown/new terminal stop_reason (blocklist, not allowlist)', () => {
    expect(
      isTranscriptTurnComplete(
        summary({ lastAssistantStopReason: 'model_context_window_exceeded' })
      )
    ).toBe(true);
  });
  it('false when a tool is still in flight even if end_turn', () => {
    expect(
      isTranscriptTurnComplete(summary({ lastAssistantStopReason: 'end_turn', openToolUses: 1 }))
    ).toBe(false);
  });
  it('false before any assistant message', () => {
    expect(isTranscriptTurnComplete(summary({ sawAssistant: false }))).toBe(false);
  });
});

describe('detectScreenActivity', () => {
  it('idle screen → not working, input ready', () => {
    expect(detectScreenActivity(IDLE_SCREEN)).toEqual({
      working: false,
      inputReady: true,
    });
  });
  it('working screen → working, not input ready', () => {
    expect(detectScreenActivity(WORKING_SCREEN)).toEqual({
      working: true,
      inputReady: false,
    });
  });
  it('trust dialog → not input ready (no empty prompt box)', () => {
    const a = detectScreenActivity(TRUST_SCREEN);
    expect(a.inputReady).toBe(false);
  });
  it('does not treat truncated chrome ellipsis as working', () => {
    const a = detectScreenActivity('│ Bug fixes and reliabil… │\n❯ \n');
    expect(a.working).toBe(false);
    expect(a.inputReady).toBe(true);
  });
});

describe('isTurnComplete (combined)', () => {
  it('complete: transcript end_turn + idle screen', () => {
    expect(isTurnComplete(summary({ lastAssistantStopReason: 'end_turn' }), IDLE_SCREEN)).toBe(
      true
    );
  });
  it('not complete while screen still shows active work, even if transcript end_turn raced ahead', () => {
    expect(isTurnComplete(summary({ lastAssistantStopReason: 'end_turn' }), WORKING_SCREEN)).toBe(
      false
    );
  });
  it('not complete when transcript still mid-tool', () => {
    expect(isTurnComplete(summary({ lastAssistantStopReason: 'tool_use' }), IDLE_SCREEN)).toBe(
      false
    );
  });

  // Regression: the review-scope false-timeout (#claude-terminal). A turn that
  // finished in seconds (end_turn + turn_duration written) stalled to
  // turnTimeoutMs because Stop-hook output kept the screen matching WORKING.
  it('complete on turn_duration marker even if the screen still looks working', () => {
    expect(
      isTurnComplete(
        summary({ lastAssistantStopReason: 'end_turn', sawTurnEnd: true }),
        WORKING_SCREEN
      )
    ).toBe(true);
  });

  it('turn_duration marker does NOT override a non-terminal transcript', () => {
    // sawTurnEnd must never complete a turn whose transcript is not itself
    // terminal — the transcript gate stays authoritative.
    expect(
      isTurnComplete(
        summary({ lastAssistantStopReason: 'tool_use', sawTurnEnd: true }),
        IDLE_SCREEN
      )
    ).toBe(false);
    expect(
      isTurnComplete(
        summary({
          lastAssistantStopReason: 'end_turn',
          openToolUses: 1,
          sawTurnEnd: true,
        }),
        IDLE_SCREEN
      )
    ).toBe(false);
  });
});
