# `/model` switching (and iv-mode status fixes) — design

**Date:** 2026-06-10
**Status:** Draft (pending spec review)

## Problem

`/model` does not work in the bridge. Typing it in a live session replies
*"No active session. Start a session to see model info."* even mid-session.

Root cause: the `!model` handler (index.js:3363) reads `session.initData.model`.
`initData` is only populated from the `system`/`init` event (index.js:1764),
which exists **only in `--print` / stream-json mode**. This deployment runs in
**interactive (iv) mode** (`MATRON_INTERACTIVE_MODE=1`), where events come from
the on-disk JSONL transcript, which never contains that init event. So
`session.initData` stays `null` forever and `/model` always hits the
"No active session" branch.

The same null `initData` also degrades:
- `/tools` (index.js:3423) → *"No session data available."* (fully broken)
- `/mcp` (index.js:3324) → falls back to a config-file-only view labelled
  "(no active session)" — misleading but not empty.

Beyond the display bug, `/model` has never been able to **switch** models — it
was only ever a read-only display.

## Goal

In interactive mode:
1. `/model` reliably shows the current model.
2. `/model <alias>` switches the model immediately (e.g. `/model sonnet`).
3. `/model` with no argument shows the current model plus tappable buttons to
   switch.
4. `/mcp` and `/tools` show accurate (best-effort) data instead of the
   misleading null-`initData` messages.

Print mode (legacy, not this deployment) keeps its existing authoritative
behavior and degrades gracefully where switching isn't possible.

## Key facts (verified)

- **`/model <alias>` in the TUI applies immediately, with no picker** — "typing
  `/model <name>` behaves like Enter" (Claude Code docs, v2.1.170). So the
  bridge can drive a switch by sending the slash command into the PTY; it does
  **not** need to scrape the interactive picker.
- Accepted args: aliases `default`, `best`, `fable`, `sonnet`, `opus`, `haiku`,
  `opusplan`; their `[1m]` long-context variants (`sonnet[1m]`, `opus[1m]`); and
  full model names (`claude-opus-4-8`).
- A model chosen via the TUI **persists across `claude --resume`** (resumed
  sessions keep the model the transcript was saved with). In iv-mode the PTY
  also stays alive, so a switch sticks for the session and survives the bridge's
  auto-resume with no extra persistence work.
- Every assistant transcript record carries `message.model` — the clean,
  authoritative source for "current model" in iv-mode.
- iv-mode has **no** authoritative source for the full MCP-server or tool list.
  The transcript only carries partial deltas (`mcp_instructions_delta`,
  `deferred_tools_delta`). So `/mcp` and `/tools` in iv-mode are **best-effort**,
  not equal to print mode's init list. (Design is honest about this in the UI.)

## Approach

**Bridge-driven direct-set**, not picker-scraping. The bridge keeps intercepting
`/model` (so it never reaches the TUI as a raw message) and:
- reads the current model from a value captured off assistant events, and
- performs switches by writing `/model <alias>` into the PTY via the existing
  `iv.sendText()` path.

Rejected alternative: forwarding `/model` to the TUI and routing its picker
through the prompt-detector. The detector's own comments
(lib/prompt-detector.js:335) flag non-interrogative pickers like `/model` as
unreliable to detect; this would be non-deterministic and hard to test.

## Components

### 1. Current-model capture (fixes the display) — index.js `handleClaudeEvent`

At the top of `handleClaudeEvent(session, event)`, add:

```js
if (event?.message?.model) session.currentModel = event.message.model;
```

`message.model` is present on `assistant` and `tools_changed` records in both
modes, so this is mode-agnostic and needs no new event wiring. `session`
gains a `currentModel: null` field in both `createSession()` (index.js:355)
and the iv-mode session object (index.js:581).

### 2. Model-alias registry — new `lib/model-aliases.js` (pure, unit-testable)

```js
export const SWITCHABLE_ALIASES = [
  { alias: 'default',    label: 'Default' },
  { alias: 'opus',       label: 'Opus' },
  { alias: 'opus[1m]',   label: 'Opus 1M' },
  { alias: 'sonnet',     label: 'Sonnet' },
  { alias: 'sonnet[1m]', label: 'Sonnet 1M' },
  { alias: 'haiku',      label: 'Haiku' },
  { alias: 'opusplan',   label: 'Opus Plan' },
  { alias: 'fable',      label: 'Fable' },
];
// Buttons shown for no-arg /model: ALL switchable aliases above (user
// decision — present every option as a button). `best` and full `claude-*`
// names stay valid/typeable but are not surfaced as buttons.
export const BUTTON_ALIASES = SWITCHABLE_ALIASES.map(m => m.alias);

export function normalizeModelArg(arg) // trim; lower-case the alias part, keep [1m]
export function isValidModelArg(arg)   // known alias | alias+[1m] | 'best' | /^claude-[a-z0-9.\-]+(\[1m\])?$/i
export function aliasLabel(arg)        // pretty label for confirmations
```

Validation accepts the documented aliases (case-insensitive), their `[1m]`
variants, `best`, and full `claude-*` names; anything else is rejected locally
with the list of known aliases (so a typo doesn't get silently typed into the
TUI). The no-arg `/model` renders a button for **every** entry in
`SWITCHABLE_ALIASES` (8 buttons), each marked `(current)` when it matches the
captured model.

### 3. `!model` handler rewrite — index.js:3363

```
session = sessions.get(roomId)
if no live session → "No active session."
arg = parts[1]
if arg:
    → switchModelInSession(session, arg, sendReply)   // see #4
else:
    current = session.currentModel || session.initData?.model || '(appears after the first reply)'
    show current model (+ CC version / fast-mode if initData present, as today)
    if session.iv and session.sendButtonMessage:
        send buttons for BUTTON_ALIASES, each value = `model:<alias>`
    else (print mode): append a note that switching needs interactive mode
```

### 4. `switchModelInSession(session, arg, send)` helper (shared)

```
if !isValidModelArg(arg) → reply "Unknown model '<arg>'. Try: default, opus, sonnet, haiku, opusplan, fable" ; return
if !session.iv → reply "Switching models needs interactive mode. Current model: <currentModel>" ; return
session.iv.sendText(`/model ${normalizeModelArg(arg)}`)
reply `Switching to <label>… (the new model takes effect on your next message)`
```

`session.currentModel` updates by itself on the next assistant turn (#1), so the
confirmation is intentionally phrased as "switching", and a later `/model` shows
the settled value.

### 5. Button-tap routing — index.js button-response block (~3586)

Buttons use a namespaced value `model:<alias>`, handled exactly like the
existing `interrupt` / `cancel:N` special cases:

```js
const modelMatch = value.match(/^model:(.+)$/);
if (modelMatch) {
  await switchModelInSession(session, modelMatch[1], sendReply);
  return;
}
```

This sits **before** the generic question-answer fall-through, so a model pick
never leaks into `waitingForAnswer`. Typed `/model sonnet` still flows through
the command path in #3 — both routes converge on #4.

### 6. `/mcp` and `/tools` — best-effort iv-mode data

Accumulate from transcript deltas in `handleClaudeEvent` (alongside #1):

- `mcp_instructions_delta` → add `addedNames` to `session.ivMcpServers` (Set)
- `deferred_tools_delta` → add `addedNames` to `session.ivTools` (Set); also
  capture the base tool set already surfaced on assistant records if available.

Handler changes:
- `!mcp` (3324): when `initData` is absent but `session.ivMcpServers` is
  non-empty, list those names with a "(interactive mode — connected servers,
  may be incomplete)" note instead of the "(no active session)" config-only
  view. Keep the print-mode `initData.mcp_servers` path and the config fallback
  unchanged.
- `!tools` (3423): when `initData` is absent but `session.ivTools` is non-empty,
  render the same built-in/MCP grouping from that set, with a best-effort note.
  When neither is available, show an honest "tool list isn't exposed in
  interactive mode yet" message rather than "No session data available."

This is explicitly lower-fidelity than print mode. If full fidelity matters more
than shipping now, #6 can be split into a follow-up PR and this one scoped to
`/model` only (see Open questions).

## Data flow (switch, iv-mode)

```
Matrix "/model sonnet"  OR  tap [Sonnet] button (value "model:sonnet")
  → room.message handler
      → command intercept (3518) routes "/model sonnet" → handleCommand !model → #4
        OR button-response block (3586) matches model:sonnet → #4
  → switchModelInSession: iv.sendText("/model sonnet")  → PTY  → TUI applies instantly
  → reply "Switching to Sonnet…"
  next user turn → assistant record message.model = "claude-sonnet-…"
      → handleClaudeEvent (#1) sets session.currentModel
      → subsequent /model shows the new model
```

## Error handling

- Invalid alias → local rejection with the known-alias list (no PTY write).
- No live session → "No active session." (unchanged contract).
- Print mode / no `session.iv` → graceful "switching needs interactive mode"
  message; never calls `iv.sendText` on a null `iv`.
- `iv.sendText` failures surface through its existing `alive` guard
  (interactive-session.js:67); no new throw sites.

## Testing

- **`lib/model-aliases.js`** — unit tests: valid aliases, `[1m]` variants, full
  `claude-*` names, rejects garbage; `normalizeModelArg` / `aliasLabel`.
- **current-model capture** — unit test: feeding an assistant-shaped event sets
  `session.currentModel`; non-model events leave it untouched.
- **`switchModelInSession`** — unit test with a fake `session.iv` (capturing
  `sendText` calls): valid alias writes `/model <alias>`; invalid alias writes
  nothing and replies with the list; null `iv` replies gracefully.
- **button routing** — assert a `model:<alias>` button value reaches
  `switchModelInSession` and does not fall through to the question handler.
- **Live verification** — drive `/model sonnet` against the running bridge and
  confirm the next assistant turn reports Sonnet (open question: confirm a
  bracketed-paste slash command registers as a command in the TUI; if not, write
  the command to the PTY raw instead of via bracketed paste — resolved in
  implementation).

## Open questions / decisions (confirm on spec review)

1. **Button set** — RESOLVED: present every switchable alias as a button
   (Default · Opus · Opus 1M · Sonnet · Sonnet 1M · Haiku · Opus Plan · Fable).
2. **`/mcp` + `/tools` fidelity** — design ships a best-effort iv-mode fix. If
   you'd rather not ship lower-fidelity lists, we split #6 into a follow-up and
   scope this PR to `/model`.
3. **Slash-command injection** — `iv.sendText` uses bracketed paste; need to
   confirm a pasted `/model …` registers as a slash command (vs. literal text).
   Fallback is a raw PTY write. Verified during implementation.

## Out of scope

- Scraping the interactive `/model` picker (rejected approach).
- Print-mode model switching via session restart with `--model` (possible
  follow-up; this deployment is iv-mode).
- Persisting the model choice beyond what `claude --resume` already does.
