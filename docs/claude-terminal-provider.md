# `claude-terminal` — Terminal-automation Claude provider

> **Status:** Community provider (`builtIn: false`). Augments — does **not** replace — the built-in SDK-based `claude` provider, which remains the default.
>
> **Provider id:** `claude-terminal` · **Display name:** `Claude Code (terminal · community)`
>
> **Validated against:** Claude Code `2.1.16x` (transcript shapes captured on 2.1.166–2.1.167) · terminalcp `^1.3.3`.

This is a candid, maintainer-oriented reference: it documents what the provider does, how to use it, how it differs from the native `claude` provider, and — importantly — where it is **fragile**. If you just want the capability matrix, jump to [Capabilities vs native `claude`](#capabilities-vs-native-claude).

---

## 1. What it is

`claude-terminal` drives the **interactive Claude Code TUI** (the `claude` app you use in a terminal) under a pseudo-terminal via [`@mariozechner/terminalcp`](https://github.com/badlogic/terminalcp), and reads structured events from Claude Code's **on-disk session transcript** (`~/.claude/projects/<dashed-cwd>/<session-id>.jsonl`).

It deliberately does **not** use the Claude Agent SDK's headless `-p` / `--output-format stream-json` path (that's what the built-in `claude` provider uses). Data is read from the transcript JSONL, **never** by scraping the rendered screen — the screen is used only as a coarse boot/idle signal.

**Why you might want it:** you get the real, interactive Claude Code environment (your global config, plugins, statusline, skills, MCP servers — exactly as a human runs it), rather than the SDK's headless surface.

**Why it costs you something:** you take on a reverse-engineered dependency on Claude Code's internal TUI + transcript behavior, plus several capability and operational gaps (sections [6](#6-the-real-gaps-vs-native-claude) and [8](#8-fragility--version-coupling)).

### Execution model

- **Spawn-per-turn + `--resume`.** Each turn boots a fresh `claude` session and (from turn 2) resumes the prior session id, which **appends** to the same transcript file. This is lifecycle-safe: there is no long-lived orphaned PTY process between turns.
- **Transcript-authoritative.** Assistant text, thinking, tool calls, tool results, token usage, and `stop_reason` are all read from the transcript. The screen only tells us "is it still working / is the input box ready / is the trust dialog up".

---

## 2. Requirements & installation

| Requirement | Why | Notes |
|---|---|---|
| **`node` on `PATH`** | terminalcp's daemon (xterm.js-headless + node-pty) renders an **empty screen under Bun** | The provider runs terminalcp under `node` explicitly (via `Bun.which('node')`), even though Archon itself runs on Bun |
| **`claude` (Claude Code CLI) on `PATH`** | the provider spawns the real CLI | Or set `claudeBinaryPath` in config / `CLAUDE_BIN_PATH` |
| **terminalcp installed** | the PTY driver | Ships as an **optionalDependency** of `@archon/providers` (`@mariozechner/terminalcp@^1.3.3`) |
| **Executable node-pty `spawn-helper`** | node-pty's prebuilt helper ships **non-executable** (`0644`) → `posix_spawnp failed` | A **root `postinstall`** (`scripts/fix-node-pty-perms.ts`) `chmod +x`'s it automatically after `bun install` |
| **macOS / Linux** | node-pty PTY support | The postinstall is a no-op on Windows; terminalcp/node-pty on Windows is untested here |

> **Not supported in compiled Archon binaries.** The provider needs `node` and `claude` on `PATH`, so it works on **source/dev installs** only. Running terminalcp inside a compiled binary (no `node`) is an open item.

If `posix_spawnp failed` ever recurs (e.g. an `npx`-fetched terminalcp copy), fix it manually:

```bash
chmod +x node_modules/**/node-pty/prebuilds/*/spawn-helper
```

---

## 3. Enabling & selecting it

The provider self-registers (idempotently) at every entrypoint. Select it like any other provider:

- **Per workflow / per node:** `provider: claude-terminal`
- **As the global default:** `DEFAULT_AI_ASSISTANT=claude-terminal`
- **Per-project config defaults:** an `assistants.claude-terminal` block in `.archon/config.yaml`

```yaml
# .archon/config.yaml
assistants:
  claude-terminal:
    model: sonnet                 # forwarded to `claude --model` (any name the CLI accepts)
    # claudeBinaryPath: /absolute/path/to/claude
    # terminalcpCommand: "node /abs/path/to/terminalcp/dist/index.js"
    turnTimeoutMs: 600000         # default 10 min (backstop only — see §7)
    pollIntervalMs: 800           # default 800 ms transcript/screen poll
```

---

## 4. Configuration options

All keys live under `assistants.claude-terminal`. All are optional and parsed defensively (invalid values are dropped, never throw).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `model` | string | (CLI default) | Passed verbatim to `claude --model`. Archon does **not** validate model names — the CLI/API is the source of truth. |
| `claudeBinaryPath` | string | resolver → `Bun.which('claude')` → `claude` | Absolute path to the Claude Code executable. Falls back to `CLAUDE_BIN_PATH` / `PATH`. |
| `claudeConfigDir` | string | `~/.claude` | Isolated `CLAUDE_CONFIG_DIR` for the spawned TUI — see [§4.1](#41-config-isolation-claude_config_dir). A leading `~` is expanded; relative paths resolve against `$HOME`. |
| `terminalcpCommand` | string | workspace terminalcp under `node` | How to invoke terminalcp (space-separated). Override to use a different launcher. Falls back to `npx -y @mariozechner/terminalcp` if not installed. |
| `turnTimeoutMs` | number > 0 | `600000` (10 min) | Hard wall-clock per turn. A **backstop**, not the normal completion path (see §7). |
| `pollIntervalMs` | number > 0 | `800` | How often the transcript + screen are polled while awaiting a turn. |

Other per-turn inputs come from the workflow node / request, not config: `model`, `systemPrompt` (→ `--append-system-prompt`), `allowed_tools`/`denied_tools`, `mcp` (→ `--mcp-config`), `output_format`, codebase env vars, and `abortSignal`.

### 4.1 Config isolation (`CLAUDE_CONFIG_DIR`)

By default the spawned TUI uses your personal `~/.claude` — the same config, login, skills, MCP servers, and plugins you use by hand. To give Archon its **own** Claude environment, set `claudeConfigDir`:

```yaml
assistants:
  claude-terminal:
    claudeConfigDir: ~/.archon/claude-home   # any absolute path or ~/…
```

This exports `CLAUDE_CONFIG_DIR=<dir>` into the spawned TUI **and** points the provider's transcript reader at `<dir>/projects`, so both sides stay in sync. One directory isolates **everything user-scoped** (verified against Claude Code 2.1.179):

- `<dir>/settings.json`, `<dir>/agents/`, `<dir>/CLAUDE.md`, `<dir>/projects/` (transcripts), caches — the whole `.claude` dir contents.
- `<dir>/.claude.json` — the **auth/login** session **and** user-scope MCP server config (Claude Code resolves this file at `$CLAUDE_CONFIG_DIR/.claude.json` when the var is set).

So a single `claudeConfigDir` **fully hides** your real `~/.claude` *and* `~/.claude.json` from Archon's instances — no `HOME` relocation, no bind mounts.

> **⚠️ Provision the dir once before unattended use.** A fresh config dir is unauthenticated, so the first interactive launch shows the login + onboarding screens. This provider drives the TUI unattended and only dismisses the *folder-trust* dialog — it deliberately does **not** script login/onboarding. **Run `CLAUDE_CONFIG_DIR=<dir> claude` once by hand** (log in, finish onboarding); after that only the per-project trust dialog appears, which the provider handles. If you skip this, the first turn fails at boot with `did not become input-ready` — and the error names the dir and the exact provisioning command.

**Precedence** (highest first): this `claudeConfigDir` config option → a `CLAUDE_CONFIG_DIR` in the request env bag → an ambient `CLAUDE_CONFIG_DIR` in Archon's own environment → the default `~/.claude`. The trusted config option deliberately wins over the env bag: that bag is a flat merge that includes a **cloned repo's untrusted `env:` block** (`.archon/config.yaml` is untrusted input — Archon clones and runs arbitrary repos), so an explicit operator isolation setting must not be silently reversible by forwarded env. When none is set, behavior is byte-identical to before (no env injected, default transcript root).

**Scope (this is config isolation, not a sandbox).** `CLAUDE_CONFIG_DIR` isolates the **user config dir + auth**. It does **not** sandbox inherited process env (`ANTHROPIC_*`, `CLAUDE_CODE_*`) or enterprise/system *managed* settings, and — like `claudeBinaryPath`/`terminalcpCommand` — a repo's own `.archon/config.yaml` `assistants:` block can still override the value (repo assistant config takes precedence over global). Treat `claudeConfigDir` as defense-in-depth for keeping Archon off your personal config, **not** as a security boundary against untrusted repos. For a real *execution* boundary, rely on Archon's worktree isolation (§6.4) — and note that worktrees share `HOME`, so an untrusted run can already reach `~/.claude*` via the shell regardless of this setting.

---

## 5. Capabilities vs native `claude`

The native `claude` provider declares **all 14 capabilities `true`**. Here is the side-by-side:

| Capability | native `claude` | `claude-terminal` | Note |
|---|:---:|:---:|---|
| `sessionResume` | ✅ | ✅ | spawn-per-turn + `--resume` (appends to the same transcript) |
| `mcp` | ✅ | ✅ | `mcp:` → `--mcp-config` (env vars expanded at launch) |
| `skills` | ✅ | ✅ | auto-loaded from `.claude/skills` by the interactive CLI |
| `toolRestrictions` | ✅ | ✅ | `allowed_tools`/`denied_tools` → `--allowed-tools`/`--disallowed-tools` — **verified enforced** even under `--dangerously-skip-permissions` |
| `structuredOutput` | ✅ (enforced) | ⚠️ (best-effort) | SDK enforces a JSON schema; terminal appends the schema to the prompt and extracts JSON from the final transcript message |
| `envInjection` | ✅ | ✅ | codebase env vars injected into the spawned TUI's environment |
| `hooks` | ✅ | ❌ | no interactive-TUI equivalent for SDK in-process hook callbacks |
| `agents` (inline) | ✅ | ❌ | needs the SDK's `options.agents`; filesystem `.claude/agents/` still load |
| `costControl` (`maxBudgetUsd`) | ✅ | ❌ | SDK-only budget enforcement; no CLI flag |
| `effortControl` | ✅ | ❌ | not settable via a launch flag (effort is *captured* from the transcript) |
| `thinkingControl` | ✅ | ❌ | not settable via a launch flag (thinking output is still captured) |
| `fallbackModel` | ✅ | ❌ | no `--fallback-model` on the CLI |
| `sandbox` | ✅ | ❌ | not exposed by the TUI — rely on Archon's worktree isolation |
| `nativeTools` | ✅ | ❌ | can't inject in-process JS tools; falls back to the bash run-management prompt (same path as Codex/OpenCode/Copilot) |

> When `nativeTools` is `false`, Archon's orchestrator auto-appends the bash run-management prompt for project-scoped chat, so run management (`archon workflow runs/get/...`) still works — just via shelling out, not an in-process `manage_run` tool.

---

## 6. The real gaps vs native `claude`

The flag matrix above understates the differences. The substantive gaps, grouped by kind:

### 6.1 Hard gaps (native can, terminal can't)
- **Hooks** — no `PreToolUse`/`PostToolUse` gating or inspection of tool calls.
- **Inline agents** (`agents:`) — per-node inline sub-agent definitions need the SDK; only on-disk `.claude/agents/` load.
- **In-process native tools** — can't register JS tools (`manage_run`) into a subprocess (mitigated by the bash prompt).
- **Cost / effort / thinking / fallback control** — no `--max-budget`, no reasoning-effort flag, no thinking-level flag, no fallback model. (Effort & thinking are *read back* from the transcript, just not *set*.)
- **Sandbox** — not exposed by the TUI.

### 6.2 Same flag, weaker implementation
- **Structured output is best-effort.** Native uses SDK-enforced `outputFormat`; terminal augments the prompt with the schema and extracts JSON from the final assistant message. Malformed output degrades to the dag-executor's `structured_output_missing` path rather than being guaranteed.
- **Streaming is coarser** (not even a capability axis). Native streams incremental token deltas (stream-json); terminal tails the transcript, which is written at **message boundaries** and polled every ~800 ms. So: no intra-message "typing" effect and inherent poll latency.

### 6.3 Operational / deployment gaps
- **Heavier per-turn boot.** Both providers spawn per turn, but terminal boots the **full interactive TUI** (trust dialog, input-readiness polling, plugins, statusline) — ~6 s to first output in practice — vs the SDK's lighter headless `-p`.
- **Deployment surface.** Needs `node` **and** `claude` on `PATH`; **no compiled-binary support**.
- **Dependency fragility.** terminalcp (optional) → node-pty native bindings → a `spawn-helper` that needs a postinstall `chmod`.
- **Turn-end & liveness are heuristics** (see §7), not a clean SDK `result` message.

### 6.4 Security posture
Under the default `--dangerously-skip-permissions`, **`denied_tools` is the only tool guard** — there are no permission prompts, no sandbox, and no `PreToolUse` hook to gate execution. `denied_tools` removes *named* tools (verified: denying `Bash` genuinely makes Bash unavailable), but everything you don't deny runs unprompted. **It is not a sandbox.** Use worktree isolation for a real execution boundary, and restrict tools explicitly.

### 6.5 What is *not* a gap
`toolRestrictions`, `sessionResume`, `mcp`, `skills`, and `envInjection` all work behaviorally (verified). Token accounting matches native exactly — both sum only `input`/`output` and ignore `cache_read`/`cache_creation` tokens in the headline `TokenUsage`, so a lower `input` count on a cached/resumed turn is parity-correct, not a bug.

---

## 7. How a turn works (and its failure modes)

```
1. resolve config + claude binary; pick a session id (new uuid, or the prior id to --resume)
2. start the TUI under terminalcp:  cd <cwd> && env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT  claude <flags>
3. input-readiness: dismiss the folder-trust dialog, wait for the empty input box, clear pre-filled text (Ctrl+U)
4. inject the prompt:  bracketed-paste + Enter   (raw \n does not submit; a paste burst + Enter does)
5. tail the transcript → yield assistant / thinking / tool / tool_result chunks
6. turn-end when the transcript shows a terminal stop_reason with no open tool, and the screen is no longer "working"
7. emit `result` (sessionId, aggregated tokens, best-effort structuredOutput, stopReason)
8. stop the session (always, via finally)
```

**Launch flags it sets** (all session-level, not `--print`-gated): `--session-id` / `--resume`, `--model`, `--dangerously-skip-permissions` (default) *or* `--permission-mode`, `--mcp-config`, `--append-system-prompt`, `--allowed-tools` / `--disallowed-tools`, `--add-dir`. It strips `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` from the child env so the spawned TUI isn't treated as a nested Claude session.

**Turn-completion** is a non-terminal **blocklist**: a turn is complete on *any* `stop_reason` **except** `tool_use` and `pause_turn` (with no open tool calls). This means a `max_tokens`/`refusal`/future-terminal finish completes promptly instead of hanging, and the screen "working" check only holds completion back while the TUI is visibly generating.

**Dead-session fast-path.** If the `claude` child dies mid-turn (a crash, or a Claude session/usage-limit notice that ends the CLI), no terminal `stop_reason` is ever written — so the provider polls terminalcp `list` for the session's `running`/`stopped` status. On a **confirmed** dead reading (twice), it throws *"exited before completing the turn"* instead of waiting out `turnTimeoutMs`. An inconclusive `list` (the command itself failed) is treated as transient and **not** counted, so a flaky `list` can't false-abort a live turn.

**`turnTimeoutMs` is a backstop, not the normal path.** With the two mechanisms above, the 10-minute default only matters for a child that is *alive but wedged* (a hung tool, an infinite spinner). Lower it only if your turns are short and you want faster give-up; raise it for long agentic turns.

---

## 8. Fragility & version coupling

**This is the single biggest difference from native `claude`, and the thing most likely to break.** The provider rides Claude Code's *internal* TUI and transcript surface, which has no compatibility contract. Things it depends on that can change between Claude Code versions:

| Internal behavior depended on | What breaks if it changes | Symptom |
|---|---|---|
| Transcript JSONL line shapes (`assistant`/`user`/`tool_use`/`tool_result`, `usage`, `stop_reason`) | chunk mapping / token aggregation | missing or malformed streamed output |
| The `<synthetic>` resume-bootstrap marker (`"Continue from where you left off." → "No response requested."`) | resume turn-detection | turn 2 returns the bootstrap line and stops before answering |
| terminalcp `list` output format (`  <id>` / `    Status: running\|stopped`) | dead-session detection | either never fails fast, or **false-aborts every live turn** |
| Folder-trust dialog wording | boot | hangs at boot, never becomes input-ready |
| Screen "working"/idle rendering (spinner, "esc to interrupt", `❯` box) | idle/boot heuristics | premature completion or boot hang |
| CLI flag names (`--resume`, `--disallowed-tools`, …) | launch | the CLI errors on launch |

> Two of these (the `<synthetic>` marker and the `list` format) actually bit during development — both were caught only by **live runs against a real Claude**, not by unit tests. When upgrading Claude Code, re-run the live checks (tool restriction, resume across two turns, a multi-tool turn) before trusting the provider in workflows. The SDK-based `claude` provider has none of this coupling.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `terminalcp could not spawn a PTY (posix_spawnp failed)` | node-pty `spawn-helper` isn't executable | re-run `bun install` (root postinstall chmods it), or `chmod +x node_modules/**/node-pty/prebuilds/*/spawn-helper` |
| Boot times out / "did not become input-ready" | terminalcp running under Bun (empty screen), or `claude` not found, or an unexpected trust/onboarding screen | ensure `node` **and** `claude` are on `PATH`; check `claudeBinaryPath` |
| `transcript … never appeared` | `claude` failed to start the session, or `~/.claude/projects` isn't where expected | run `claude` manually in the cwd once; check `ARCHON_HOME`/`HOME` |
| Turn ends with `exited before completing the turn` | the `claude` child died (crash or **session/usage limit**) | check your Claude plan/limits; re-run later |
| Resume turn returns a wrong/empty answer after a Claude Code upgrade | the `<synthetic>` marker changed | re-verify resume; update `isSyntheticAssistant` in `transcript.ts` |
| Every turn aborts after ~1.6 s with "exited before completing" | terminalcp `list` format changed | update the `isSessionAlive` parser in `terminalcp.ts` |
| `structured_output_missing` warnings | best-effort JSON extraction failed | tighten the prompt/schema, or use the native `claude` provider where structured output is SDK-enforced |
| Plugin/"what's new" panels in the TUI | your global Claude Code config is active in the spawned session | harmless — data is read from the transcript, and the input box is cleared before paste; disable noisy plugins globally if desired |

---

## 10. When to use which

**Use `claude-terminal` when** you want the *real* interactive Claude Code environment for chat/agentic turns — your global config, plugins, skills, MCP servers — and you're on a source/dev install with `node` + `claude` on `PATH`.

**Use the built-in `claude` (SDK) provider when** you need any of: hook-based governance, a sandbox, cost/effort/thinking/fallback control, SDK-enforced structured output, inline per-node agents, in-process native tools, compiled-binary deployment, or you simply want the lowest-maintenance, contract-backed integration. It remains the default for good reason.

---

## See also

- The capability matrix + setup in the published docs: `packages/docs-web/src/content/docs/getting-started/ai-assistants.md` ("Claude (Terminal · Community Provider)").
- Source: `packages/providers/src/community/claude-terminal/`.
- [`@mariozechner/terminalcp`](https://github.com/badlogic/terminalcp) — the terminal-automation library.
- Adding a community provider: `packages/docs-web/src/content/docs/contributing/adding-a-community-provider/`.
