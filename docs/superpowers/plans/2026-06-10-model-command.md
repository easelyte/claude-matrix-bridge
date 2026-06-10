# `/model` switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/model` work in the Matrix bridge — reliably show the current model in interactive mode, switch models with `/model <alias>`, and offer tappable model buttons for the no-argument form.

**Architecture:** Bridge-driven direct-set. The bridge keeps intercepting `/model` (it never reaches the TUI as raw text). The current model is captured from each assistant transcript event (`message.model`) onto `session.currentModel`. A switch is performed by writing `/model <alias>` into the live PTY via the existing `session.iv.sendText()`, which the CLI applies immediately with no picker. Pure logic (alias registry, validation, switch decision, button list) lives in new `lib/` modules with unit tests; `index.js` is the thin integration shell.

**Tech Stack:** Node.js (ESM), vitest for tests. No new dependencies.

**Scope note:** This plan covers `/model` only. `/mcp` and `/tools` are intentionally excluded — iv-mode has no authoritative source for the full MCP-server or tool list (transcript deltas are partial and would mislead), so they need a separate decision and are not bundled here.

---

## File Structure

- **Create `lib/model-aliases.js`** — pure alias registry + validation + the `message.model` extractor. One responsibility: "what is a valid model argument and how do we read the current model."
- **Create `lib/model-command.js`** — the `/model` command behaviors that operate on an injected `session` + `send` callback: `switchModelInSession()` and `modelButtons()`. Depends on `model-aliases.js`.
- **Create `test/model-aliases.test.js`**, **Create `test/model-command.test.js`** — unit tests.
- **Modify `index.js`** — import the new modules; capture `currentModel` in `handleClaudeEvent`; add `currentModel: null` to both session objects; rewrite the `!model` handler; route `model:<alias>` button taps.

Current relevant `index.js` line anchors (on branch `feat/iv-model-switch`, == master): `handleClaudeEvent` `system` case ~1763; print-mode session object ~355; iv-mode session object ~581; button-response block ~3586; `!model` handler ~3363; `sendReply`/`sendHtmlFn` defined ~3514.

---

## Task 1: Model alias registry + validation (`lib/model-aliases.js`)

**Files:**
- Create: `lib/model-aliases.js`
- Test: `test/model-aliases.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/model-aliases.test.js
import { describe, it, expect } from 'vitest';
import {
  SWITCHABLE_ALIASES,
  VALID_ALIAS_HINT,
  isValidModelArg,
  normalizeModelArg,
  aliasLabel,
  modelFromEvent,
} from '../lib/model-aliases.js';

describe('SWITCHABLE_ALIASES', () => {
  it('lists the eight switchable models with labels', () => {
    expect(SWITCHABLE_ALIASES.map(m => m.alias)).toEqual([
      'default', 'opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'opusplan', 'fable',
    ]);
    for (const m of SWITCHABLE_ALIASES) expect(typeof m.label).toBe('string');
  });
});

describe('isValidModelArg', () => {
  it('accepts known aliases case-insensitively', () => {
    expect(isValidModelArg('sonnet')).toBe(true);
    expect(isValidModelArg('OPUS')).toBe(true);
    expect(isValidModelArg('opusplan')).toBe(true);
    expect(isValidModelArg('best')).toBe(true);
  });
  it('accepts [1m] long-context variants', () => {
    expect(isValidModelArg('opus[1m]')).toBe(true);
    expect(isValidModelArg('sonnet[1m]')).toBe(true);
  });
  it('accepts full claude-* model names (with optional [1m])', () => {
    expect(isValidModelArg('claude-opus-4-8')).toBe(true);
    expect(isValidModelArg('claude-opus-4-8[1m]')).toBe(true);
  });
  it('rejects unknown garbage', () => {
    expect(isValidModelArg('banana')).toBe(false);
    expect(isValidModelArg('')).toBe(false);
    expect(isValidModelArg(undefined)).toBe(false);
  });
});

describe('normalizeModelArg', () => {
  it('trims and lower-cases', () => {
    expect(normalizeModelArg('  Sonnet ')).toBe('sonnet');
    expect(normalizeModelArg('OPUS[1M]')).toBe('opus[1m]');
  });
});

describe('aliasLabel', () => {
  it('returns the pretty label for a known alias', () => {
    expect(aliasLabel('opusplan')).toBe('Opus Plan');
    expect(aliasLabel('opus[1m]')).toBe('Opus 1M');
  });
  it('falls back to the raw arg for full names', () => {
    expect(aliasLabel('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});

describe('VALID_ALIAS_HINT', () => {
  it('is a comma-separated hint of switchable aliases', () => {
    expect(VALID_ALIAS_HINT).toContain('sonnet');
    expect(VALID_ALIAS_HINT).toContain('opusplan');
  });
});

describe('modelFromEvent', () => {
  it('reads message.model from an assistant-shaped event', () => {
    expect(modelFromEvent({ message: { model: 'claude-opus-4-8' } })).toBe('claude-opus-4-8');
  });
  it('returns null when there is no model', () => {
    expect(modelFromEvent({ type: 'system', subtype: 'init' })).toBe(null);
    expect(modelFromEvent(null)).toBe(null);
    expect(modelFromEvent({ message: {} })).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/model-aliases.test.js`
Expected: FAIL — `Cannot find module '../lib/model-aliases.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/model-aliases.js
// Registry of switchable model aliases (shown as buttons for the no-arg
// /model) plus validation/labelling for `/model <arg>`. The in-TUI
// `/model <alias>` command applies immediately with no picker (Claude Code
// docs), so the bridge validates here then drives the alias into the PTY.

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

// 'best' is valid to type but not surfaced as a button.
const KNOWN_ALIASES = new Set([...SWITCHABLE_ALIASES.map(m => m.alias), 'best']);

// Full model names like claude-opus-4-8 or claude-opus-4-8[1m].
const FULL_NAME_RE = /^claude-[a-z0-9.\-]+(\[1m\])?$/;

export const VALID_ALIAS_HINT = SWITCHABLE_ALIASES.map(m => m.alias).join(', ');

export function normalizeModelArg(arg) {
  return String(arg ?? '').trim().toLowerCase();
}

export function isValidModelArg(arg) {
  const a = normalizeModelArg(arg);
  if (!a) return false;
  return KNOWN_ALIASES.has(a) || FULL_NAME_RE.test(a);
}

export function aliasLabel(arg) {
  const a = normalizeModelArg(arg);
  const found = SWITCHABLE_ALIASES.find(m => m.alias === a);
  if (found) return found.label;
  if (a === 'best') return 'Best';
  return a;
}

// Current model is read off any event carrying message.model (assistant /
// tools_changed records in both print and iv mode). Returns null otherwise.
export function modelFromEvent(event) {
  const m = event?.message?.model;
  return typeof m === 'string' && m ? m : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/model-aliases.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/model-aliases.js test/model-aliases.test.js
git commit -m "feat: model alias registry, validation, and current-model extractor"
```

---

## Task 2: Switch + button-list behaviors (`lib/model-command.js`)

**Files:**
- Create: `lib/model-command.js`
- Test: `test/model-command.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/model-command.test.js
import { describe, it, expect } from 'vitest';
import { switchModelInSession, modelButtons } from '../lib/model-command.js';

function fakeSession({ iv = null, currentModel = null } = {}) {
  const sent = [];
  const typed = [];
  return {
    currentModel,
    iv: iv === 'live' ? { alive: true, sendText: (t) => typed.push(t) } : iv,
    _sent: sent,
    _typed: typed,
    send: (m) => sent.push(m),
  };
}

describe('switchModelInSession', () => {
  it('drives /model <alias> into the PTY and confirms on a valid alias', () => {
    const s = fakeSession({ iv: 'live' });
    const ok = switchModelInSession(s, 'sonnet', s.send);
    expect(ok).toBe(true);
    expect(s._typed).toEqual(['/model sonnet']);
    expect(s._sent.join(' ')).toMatch(/Sonnet/);
  });

  it('normalizes the alias before sending', () => {
    const s = fakeSession({ iv: 'live' });
    switchModelInSession(s, '  OPUS[1M] ', s.send);
    expect(s._typed).toEqual(['/model opus[1m]']);
  });

  it('rejects an unknown alias without touching the PTY', () => {
    const s = fakeSession({ iv: 'live' });
    const ok = switchModelInSession(s, 'banana', s.send);
    expect(ok).toBe(false);
    expect(s._typed).toEqual([]);
    expect(s._sent.join(' ')).toMatch(/Unknown model/);
  });

  it('degrades gracefully when there is no live TUI (print mode)', () => {
    const s = fakeSession({ iv: null, currentModel: 'claude-opus-4-8' });
    const ok = switchModelInSession(s, 'sonnet', s.send);
    expect(ok).toBe(false);
    expect(s._sent.join(' ')).toMatch(/interactive mode/);
    expect(s._sent.join(' ')).toMatch(/claude-opus-4-8/);
  });
});

describe('modelButtons', () => {
  it('builds one namespaced button per switchable alias', () => {
    const buttons = modelButtons();
    expect(buttons).toHaveLength(8);
    expect(buttons[0]).toEqual({ id: 'model-default', label: 'Default', value: 'model:default' });
    expect(buttons.find(b => b.label === 'Opus 1M')).toEqual({
      id: 'model-opus[1m]', label: 'Opus 1M', value: 'model:opus[1m]',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/model-command.test.js`
Expected: FAIL — `Cannot find module '../lib/model-command.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/model-command.js
// /model command behaviors that operate on an injected session object and a
// `send(message)` callback, so they are unit-testable without the Matrix
// client. switchModelInSession drives the in-TUI /model command; modelButtons
// builds the no-arg picker buttons.

import {
  SWITCHABLE_ALIASES,
  VALID_ALIAS_HINT,
  isValidModelArg,
  normalizeModelArg,
  aliasLabel,
} from './model-aliases.js';

// Validate, then write `/model <alias>` into the live PTY. Returns true when a
// switch was driven. `send` is called with a human-readable status string.
export function switchModelInSession(session, arg, send) {
  if (!isValidModelArg(arg)) {
    send(`Unknown model "${arg}". Try: ${VALID_ALIAS_HINT} (or a full claude-* name).`);
    return false;
  }
  if (!session.iv || typeof session.iv.sendText !== 'function') {
    send(`Switching models needs interactive mode. Current model: ${session.currentModel || '(unknown)'}`);
    return false;
  }
  const normalized = normalizeModelArg(arg);
  session.iv.sendText(`/model ${normalized}`);
  send(`Switching to ${aliasLabel(arg)}… (takes effect on your next message)`);
  return true;
}

// One Matrix button per switchable alias. value is namespaced `model:<alias>`
// so the button-response handler can dispatch it explicitly.
export function modelButtons() {
  return SWITCHABLE_ALIASES.map(m => ({
    id: `model-${m.alias}`,
    label: m.label,
    value: `model:${m.alias}`,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/model-command.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/model-command.js test/model-command.test.js
git commit -m "feat: switchModelInSession + modelButtons behaviors"
```

---

## Task 3: Capture the current model in `handleClaudeEvent`

**Files:**
- Modify: `index.js` (import near line 18; `handleClaudeEvent` top; session objects ~355 and ~581)

- [ ] **Step 1: Add the import**

Add after the existing `lib/mcp-config.js` import (~line 18):

```js
import { modelFromEvent } from './lib/model-aliases.js';
```

- [ ] **Step 2: Capture at the top of `handleClaudeEvent`**

Find the start of `function handleClaudeEvent(session, event) {` and insert as the first statements in the body:

```js
  const capturedModel = modelFromEvent(event);
  if (capturedModel) session.currentModel = capturedModel;
```

- [ ] **Step 3: Add the `currentModel` field to both session objects**

In the print-mode session object literal (the one with `initData: null,` near line 380) add:

```js
    currentModel: null,
```

In the iv-mode session object literal (the one with `initData: null,` near line 603) add the same line:

```js
    currentModel: null,
```

- [ ] **Step 4: Verify the file still parses and tests pass**

Run: `node --check index.js && npx vitest run`
Expected: parses; all tests PASS (no behavior change yet beyond capture).

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: capture session.currentModel from assistant events (fixes /model in iv-mode)"
```

---

## Task 4: Rewrite the `!model` handler (show + switch + buttons)

**Files:**
- Modify: `index.js` — import (~line 19) and the `case '!model':` block (~3363)

- [ ] **Step 1: Add the import**

Add after the `model-aliases.js` import:

```js
import { switchModelInSession, modelButtons } from './lib/model-command.js';
```

- [ ] **Step 2: Replace the `case '!model':` block**

Replace the existing block (currently lines ~3363–3374) with:

```js
    case '!model': {
      const session = sessions.get(roomId);
      if (!session || !session.alive) {
        await sendReply('No active session. Start a session to see model info.');
        break;
      }
      const arg = parts[1];
      if (arg) {
        switchModelInSession(session, arg, sendReply);
        break;
      }
      const current = session.currentModel || session.initData?.model || null;
      const extra = session.initData
        ? `\nClaude Code: v${session.initData.claude_code_version || '(unknown)'}\nFast mode: ${session.initData.fast_mode_state || 'off'}`
        : '';
      const currentLine = current ? `Current model: ${current}` : 'Current model: (appears after the first reply)';
      if (session.iv && session.sendButtonMessage) {
        const buttons = modelButtons();
        const plain = `${currentLine}${extra}\n\nTap a model to switch, or type /model <name>.`;
        const htmlButtons = buttons.map(b => `<b>${escapeHtml(b.label)}</b>`).join(' · ');
        const html = `<b>🧠 ${escapeHtml(currentLine)}</b>${extra ? '<br/>' + escapeHtml(extra.trim()).replace(/\n/g, '<br/>') : ''}` +
          `<br/><br/>Tap a model to switch, or type <code>/model &lt;name&gt;</code>.<br/>${htmlButtons}`;
        session.sendButtonMessage(currentLine, buttons, 'pick_one', plain, html);
      } else {
        await sendReply(`${currentLine}${extra}\n\nSwitching models needs interactive mode.`);
      }
      break;
    }
```

- [ ] **Step 3: Verify parse + lint + tests**

Run: `node --check index.js && npx eslint index.js --max-warnings=0 && npx vitest run`
Expected: parses, lint clean, tests PASS.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: /model shows current model and offers switch buttons in iv-mode"
```

---

## Task 5: Route `model:<alias>` button taps

**Files:**
- Modify: `index.js` — button-response block (~3586), right after the `cancel:` handler and before the "treat as a question answer" fall-through comment (~3634).

- [ ] **Step 1: Insert the dispatch**

After the `cancelMatch` `if` block closes (the `return;` at ~3634) and before the comment `// Otherwise treat as a question answer`, insert:

```js
    const modelMatch = value.match(/^model:(.+)$/);
    if (modelMatch) {
      switchModelInSession(session, modelMatch[1], sendReply);
      return;
    }
```

(`sendReply` is already in scope in this handler, defined ~line 3514. `switchModelInSession` is imported in Task 4.)

- [ ] **Step 2: Verify parse + lint + tests**

Run: `node --check index.js && npx eslint index.js --max-warnings=0 && npx vitest run`
Expected: parses, lint clean, all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: route /model picker button taps to a model switch"
```

---

## Task 6: Live verification

**Files:** none (manual verification against a running bridge).

> Requires deploying this branch and restarting the bridge (`sudo systemctl restart claude-matrix-bridge.service`), which ends any active session. Do this from a throwaway/again-startable Matrix session, not the one you are working in.

- [ ] **Step 1: Confirm the display fix**

In a live iv-mode session, send `/model`. Expected: a message showing `Current model: claude-…` plus 8 model buttons — NOT "No active session".

- [ ] **Step 2: Confirm direct-set**

Send `/model sonnet`. Expected: "Switching to Sonnet…". Then send any normal message; the reply should now come from Sonnet. Re-send `/model` and confirm `Current model:` reflects a sonnet model id.

- [ ] **Step 3: Confirm button switch**

Send `/model`, tap **Opus**. Expected: "Switching to Opus…", and the next turn runs on Opus.

- [ ] **Step 4: Confirm the bracketed-paste slash command registered**

If Step 2/3 did NOT change the model (i.e. `/model sonnet` was typed into the prompt as literal text rather than executed), change `session.iv.sendText(`/model ${normalized}`)` to a raw PTY write that does not use bracketed paste, then re-verify. Specifically, add a `sendCommand(text)` method to `lib/interactive-session.js` that does `this.pty.write(text)` followed by the same delayed `keystroke('enter')` as `sendText`, and call it from `switchModelInSession`. Re-run Steps 2–3.

- [ ] **Step 5: Commit any Step-4 follow-up**

```bash
git add -A
git commit -m "fix: send /model as a raw PTY command so the TUI executes it"
```

(Skip if Step 2/3 passed as-is.)

---

## Out of scope (deferred, with rationale)

- **`/mcp` and `/tools` in iv-mode.** No authoritative source exists: `deferred_tools_delta.addedNames` lists only deferred/searchable tools (not base or MCP tools), and `mcp_instructions_delta.addedNames` lists only instruction-emitting servers. Rebuilding either would present a misleading partial list, so it is deliberately not done here. A separate, smaller change can replace their misleading "No active session" / "No session data" messages with accurate wording (and `/mcp` already has a config-file fallback). Pending a product decision on whether partial data is acceptable.
- **Print-mode switching via session restart with `--model`.** This deployment is iv-mode; switching there degrades to a graceful message.
- **Marking the "current" model on the buttons.** Alias→full-name matching is fuzzy; the current model is shown in the prompt text above the buttons instead.
