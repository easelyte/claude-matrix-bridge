# Interactive-Mode Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bridge's `claude --print --input-format stream-json` driver with a PTY-driven interactive `claude` session so the bridge continues to bill against the bundled Pro/Max plan once Anthropic restricts `--print` from plan-billed usage.

**Architecture:** Per room, the bridge spawns `claude` in a PTY (via `node-pty`) with a pre-assigned `--session-id <uuid>`. Input goes in through the PTY using bracketed-paste sequences. Events come out by **tailing the on-disk JSONL transcript** at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, which has the same event shapes as today's stream-json stdout. Turn boundaries and `ExitPlanMode` approvals are signalled via new hook scripts (`Stop`, `PreToolUse:ExitPlanMode`) that POST to the bridge's existing local HTTP API. A separate "interactive prompt handler" parses the PTY's visible buffer for any TUI dialog the hook system can't intercept (welcome screen, recovery prompts, MCP elicitation, future unknown dialogs) and converts them into Matrix multiple-choice questions whose answers are translated back into keystrokes. The whole new stack lives behind an env flag (`MATRON_INTERACTIVE_MODE=1`) so it can be developed and tested in parallel with the live `--print` bridge without touching production until cutover.

**Tech Stack:** Node 20, `node-pty` (new), `chokidar` (new — for transcript tail with rename-tolerance), existing Express HTTP API, existing bash hook script pattern, vitest for tests.

---

## Scope notes

- The bridge is currently the live communication channel with the user. Every task except those in Phase 5 (cutover) MUST be non-destructive: no `npm install`, no service restart, no edits to `index.js`'s active code paths. New code goes in new files. `index.js` only gets touched once in Phase 4, behind a feature flag that defaults off.
- The matronhq repo has just been pulled in; current `master` is at `aed3ef4`. All commits in this plan go on a new branch `feat/interactive-mode`.
- Pre-existing `--print` code path stays intact through all phases; cutover is reversible by clearing the env flag.

## File structure

**New files (created):**
- `lib/interactive-session.js` — PTY spawn + transcript tail + bracketed-paste input. Replaces the `spawn('claude', …)` block in `createSession`.
- `lib/transcript-tail.js` — File watcher for `<session-id>.jsonl`, emits parsed events.
- `lib/pty-input.js` — Helpers: `bracketedPaste(text)`, `keystroke(name)` mapping `'enter'|'up'|'down'|'esc'|'tab'|'ctrl-c'` → bytes.
- `lib/prompt-detector.js` — ANSI-stripped screen buffer + heuristic prompt classifier. Emits `prompt` events with `{ kind, question, options }`.
- `lib/pre-trust.js` — Idempotent writer that ensures `~/.claude.json` has `projects[<cwd>].hasTrustDialogAccepted: true` before spawn.
- `hooks/stop-notify.sh` — `Stop` hook → `POST /turn-end`.
- `hooks/exit-plan-decision.sh` — `PreToolUse:ExitPlanMode` hook → blocks on `POST /plan-decision`, returns `permissionDecision`.
- `test/interactive-session.test.js` — vitest unit tests using a fake `claude` shim.
- `test/transcript-tail.test.js`
- `test/pty-input.test.js`
- `test/prompt-detector.test.js`
- `test/pre-trust.test.js`
- `test/stub-claude.mjs` — A fake `claude` binary used by tests that writes a JSONL transcript and reads bracketed-paste input from stdin.

**Modified files:**
- `package.json` — add `node-pty` and `chokidar` deps; bump version.
- `index.js` — `createSession` gains a feature-flag branch that uses `lib/interactive-session.js`; new HTTP handlers `/turn-end` and `/plan-decision`. Roughly +120 lines, no removal of `--print` path until Phase 5.

---

## Phase 0 — Pre-flight verification

These tasks gate the plan. If any fails, stop and reassess before continuing.

### Task 0.1: Verify `Stop` hook exists and fires

**Goal:** Confirm Claude Code supports a `Stop` hook event in `--settings.hooks`.

- [ ] **Step 1: Create a throwaway test directory**

```bash
mkdir -p /tmp/claude-hook-test && cd /tmp/claude-hook-test
```

- [ ] **Step 2: Write a Stop hook that writes a marker file**

```bash
cat > /tmp/claude-hook-test/stop.sh <<'EOF'
#!/bin/bash
echo "{\"received_at\":\"$(date -Iseconds)\"}" > /tmp/claude-hook-test/stop-fired
cat   # echo stdin to stdout so we can inspect the payload
EOF
chmod +x /tmp/claude-hook-test/stop.sh
```

- [ ] **Step 3: Run `claude -p` with the hook registered, capture transcript**

```bash
rm -f /tmp/claude-hook-test/stop-fired
claude -p --output-format stream-json --verbose \
  --settings '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/tmp/claude-hook-test/stop.sh"}]}]}}' \
  "say hi briefly" 2>&1 | tee /tmp/claude-hook-test/run.log
```

Expected: `/tmp/claude-hook-test/stop-fired` exists after the run; `run.log` contains a `result` event.

If the file is NOT created, `Stop` is not the right event name. Try `SessionEnd`, `PostMessage`, `Notification`. Update the plan with the correct name before continuing.

- [ ] **Step 4: Inspect the hook stdin payload to confirm `session_id` is present**

```bash
claude -p --settings '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"tee /tmp/claude-hook-test/stop-payload.json"}]}]}}' "hi" >/dev/null
cat /tmp/claude-hook-test/stop-payload.json | jq .
```

Expected: JSON object with at least `session_id`, `transcript_path` (or similar). Note the exact field names — `hooks/stop-notify.sh` will need them.

- [ ] **Step 5: Document findings inline in this plan**

Edit this file to record: confirmed hook name, payload schema. If different from assumed `Stop`, search-and-replace through the plan.

### Task 0.2: Verify `--session-id` works in interactive (non-`--print`) mode

- [ ] **Step 1: Pre-trust the test dir to skip the trust dialog**

```bash
node -e 'const fs=require("fs"); const p="/home/danbarker/.claude.json"; const c=JSON.parse(fs.readFileSync(p)); c.projects=c.projects||{}; c.projects["/tmp/claude-hook-test"]={...(c.projects["/tmp/claude-hook-test"]||{}), hasTrustDialogAccepted:true, hasCompletedProjectOnboarding:true}; fs.writeFileSync(p, JSON.stringify(c,null,2));'
```

- [ ] **Step 2: Spawn claude interactively with a known session ID, exit immediately**

```bash
SID=$(uuidgen)
cd /tmp/claude-hook-test
echo "" | claude --session-id "$SID" -- /exit  # may not exit cleanly; ok
ls ~/.claude/projects/-tmp-claude-hook-test/ | grep "$SID"
```

Expected: a `<SID>.jsonl` file is created in `~/.claude/projects/-tmp-claude-hook-test/`.

If not, `--session-id` may only work with `--print`/`--resume`. In that case, switch strategy: spawn without `--session-id`, parse the session ID from the first event in the transcript directory by watching for new files.

- [ ] **Step 3: Inspect a transcript line**

```bash
head -1 ~/.claude/projects/-tmp-claude-hook-test/$SID.jsonl | jq .
```

Expected: a JSON line of type `summary` or `user` or `system` — same shape as stream-json events.

### Task 0.3: Confirm interactive mode is plan-billed

User-asserted, but worth a sanity check before committing 40 tasks of work.

- [ ] **Step 1: Run `claude` interactively for one turn, then `/cost`**

```bash
cd /tmp/claude-hook-test
claude
# In the TUI: type a one-word prompt, press Enter, wait for response, then type /cost
# Confirm the cost line says "0 (plan)" or similar — NOT a dollar amount.
# Type /exit.
```

- [ ] **Step 2: Compare with `claude -p`**

```bash
claude -p "say hi"
# Then in a new claude interactive: /cost — check whether the previous -p run incremented dollar cost.
```

If interactive runs do NOT bill against the plan, this entire plan is moot. **STOP and discuss.**

### Task 0.4: Confirm bracketed-paste injection works against a real `claude` PTY

This is the riskiest assumption in the whole plan. Validate before scaffolding.

- [ ] **Step 1: Install node-pty in a scratch dir (NOT the bridge)**

```bash
mkdir -p /tmp/pty-test && cd /tmp/pty-test
npm init -y
npm install node-pty
```

- [ ] **Step 2: Write a minimal driver script**

Create `/tmp/pty-test/drive.mjs`:

```javascript
import pty from 'node-pty';
import fs from 'node:fs';

const SID = crypto.randomUUID();
const cwd = '/tmp/claude-hook-test';
const p = pty.spawn('claude', ['--session-id', SID, '--dangerously-skip-permissions'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd,
  env: process.env,
});

let buf = '';
p.onData(d => { buf += d; process.stdout.write(d); });

// Wait for prompt to settle, then send a bracketed-paste message.
setTimeout(() => {
  const msg = 'Hello from the PTY driver — please reply with one word.';
  p.write('\x1b[200~' + msg + '\x1b[201~\r');
}, 3000);

// Tail the transcript file as it's written.
setTimeout(() => {
  const txPath = `/home/danbarker/.claude/projects/-tmp-claude-hook-test/${SID}.jsonl`;
  console.log('\n--- transcript path:', txPath);
  fs.watchFile(txPath, () => {
    const lines = fs.readFileSync(txPath, 'utf8').split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    console.log('\n--- last event:', last.type, last.message?.role || '');
  });
}, 4000);

// Exit cleanly after 30s
setTimeout(() => { p.write('/exit\r'); setTimeout(() => process.exit(0), 2000); }, 30000);
```

- [ ] **Step 3: Run it**

```bash
cd /tmp/pty-test && node drive.mjs
```

Expected:
1. PTY output shows claude's TUI appearing
2. After 3 seconds the pasted message appears in the input box
3. Pressing Enter (the `\r` after the bracketed-paste close) submits it
4. The transcript file gets new lines as claude responds
5. The "last event" log shows assistant message types

If bracketed paste doesn't work (text appears character by character, or each `\n` in a multi-line message submits early), revise input strategy: try plain `p.write(text + '\r')` for single-line and shift-enter (`\x1b\r`?) for newlines.

- [ ] **Step 4: Document the working input sequence**

Update `lib/pty-input.js` task with the empirically validated escape sequences.

---

## Phase 1 — PTY session driver (foundation)

All work in `lib/` and `test/`. No changes to `index.js`. New code is dead until Phase 4.

### Task 1.1: Add deps to package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add deps (do NOT run npm install yet — it would update node_modules under the live bridge)**

```bash
node -e '
const fs=require("fs");
const p=JSON.parse(fs.readFileSync("package.json","utf8"));
p.dependencies["node-pty"]="^1.0.0";
p.dependencies["chokidar"]="^4.0.0";
fs.writeFileSync("package.json", JSON.stringify(p,null,2)+"\n");
'
```

- [ ] **Step 2: Commit (deps recorded but uninstalled — npm install deferred to cutover)**

```bash
git checkout -b feat/interactive-mode
git add package.json
git commit -m "feat(bridge): add node-pty and chokidar deps for interactive mode"
```

### Task 1.2: `lib/pre-trust.js` — pre-write workspace trust

**Files:**
- Create: `lib/pre-trust.js`
- Test: `test/pre-trust.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/pre-trust.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureWorkspaceTrusted } from '../lib/pre-trust.js';

describe('ensureWorkspaceTrusted', () => {
  let tmpHome;
  let claudeJsonPath;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-'));
    claudeJsonPath = path.join(tmpHome, '.claude.json');
  });
  afterEach(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); });

  it('creates .claude.json with project entry when file does not exist', () => {
    ensureWorkspaceTrusted('/foo/bar', claudeJsonPath);
    const c = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(c.projects['/foo/bar'].hasTrustDialogAccepted).toBe(true);
    expect(c.projects['/foo/bar'].hasCompletedProjectOnboarding).toBe(true);
  });

  it('preserves existing top-level fields', () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({ numStartups: 42, projects: { '/other': { foo: 1 } } }));
    ensureWorkspaceTrusted('/foo/bar', claudeJsonPath);
    const c = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(c.numStartups).toBe(42);
    expect(c.projects['/other'].foo).toBe(1);
    expect(c.projects['/foo/bar'].hasTrustDialogAccepted).toBe(true);
  });

  it('is idempotent — calling twice does not change content', () => {
    ensureWorkspaceTrusted('/foo/bar', claudeJsonPath);
    const after1 = fs.readFileSync(claudeJsonPath, 'utf8');
    ensureWorkspaceTrusted('/foo/bar', claudeJsonPath);
    const after2 = fs.readFileSync(claudeJsonPath, 'utf8');
    expect(after2).toBe(after1);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
cd ~/claude-matrix-bridge && npx vitest run test/pre-trust.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```javascript
// lib/pre-trust.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_PATH = path.join(os.homedir(), '.claude.json');

export function ensureWorkspaceTrusted(workdir, claudeJsonPath = DEFAULT_PATH) {
  const abs = path.resolve(workdir);
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  } catch (_) { /* file doesn't exist or unreadable; start fresh */ }
  config.projects = config.projects || {};
  const existing = config.projects[abs] || {};
  if (existing.hasTrustDialogAccepted && existing.hasCompletedProjectOnboarding) return;
  config.projects[abs] = {
    ...existing,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npx vitest run test/pre-trust.test.js
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/pre-trust.js test/pre-trust.test.js
git commit -m "feat(bridge): pre-write workspace trust to skip TUI dialog"
```

### Task 1.3: `lib/pty-input.js` — input helpers

**Files:**
- Create: `lib/pty-input.js`
- Test: `test/pty-input.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/pty-input.test.js
import { describe, it, expect } from 'vitest';
import { bracketedPaste, keystroke } from '../lib/pty-input.js';

describe('bracketedPaste', () => {
  it('wraps text in bracketed-paste sequences and appends CR', () => {
    expect(bracketedPaste('hello')).toBe('\x1b[200~hello\x1b[201~\r');
  });
  it('preserves newlines inside the paste', () => {
    expect(bracketedPaste('a\nb')).toBe('\x1b[200~a\nb\x1b[201~\r');
  });
  it('does NOT submit when submit:false', () => {
    expect(bracketedPaste('x', { submit: false })).toBe('\x1b[200~x\x1b[201~');
  });
});

describe('keystroke', () => {
  it('maps named keys to bytes', () => {
    expect(keystroke('enter')).toBe('\r');
    expect(keystroke('up')).toBe('\x1b[A');
    expect(keystroke('down')).toBe('\x1b[B');
    expect(keystroke('right')).toBe('\x1b[C');
    expect(keystroke('left')).toBe('\x1b[D');
    expect(keystroke('esc')).toBe('\x1b');
    expect(keystroke('tab')).toBe('\t');
    expect(keystroke('ctrl-c')).toBe('\x03');
    expect(keystroke('y')).toBe('y');
  });
  it('throws on unknown key', () => {
    expect(() => keystroke('foo')).toThrow();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
npx vitest run test/pty-input.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```javascript
// lib/pty-input.js
export function bracketedPaste(text, { submit = true } = {}) {
  return `\x1b[200~${text}\x1b[201~${submit ? '\r' : ''}`;
}

const KEYS = {
  enter: '\r',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  esc: '\x1b',
  tab: '\t',
  'ctrl-c': '\x03',
};

export function keystroke(name) {
  if (KEYS[name] !== undefined) return KEYS[name];
  if (/^[\x20-\x7e]$/.test(name)) return name;
  throw new Error(`Unknown key: ${name}`);
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run test/pty-input.test.js
```

- [ ] **Step 5: Commit**

```bash
git add lib/pty-input.js test/pty-input.test.js
git commit -m "feat(bridge): pty input helpers (bracketed paste, keystroke map)"
```

### Task 1.4: `lib/transcript-tail.js` — JSONL tail

**Files:**
- Create: `lib/transcript-tail.js`
- Test: `test/transcript-tail.test.js`

This module watches the transcript file and emits parsed events as new JSON lines are appended. Handles the race where the file may not exist at watch start.

- [ ] **Step 1: Write the failing test**

```javascript
// test/transcript-tail.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TranscriptTail } from '../lib/transcript-tail.js';

describe('TranscriptTail', () => {
  let dir, file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
    file = path.join(dir, 'session.jsonl');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('emits events appended after start', async () => {
    const tail = new TranscriptTail(file);
    const events = [];
    tail.on('event', e => events.push(e));
    await tail.start();
    fs.writeFileSync(file, JSON.stringify({ type: 'user', n: 1 }) + '\n');
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', n: 2 }) + '\n');
    await new Promise(r => setTimeout(r, 200));
    await tail.stop();
    expect(events.map(e => e.n)).toEqual([1, 2]);
  });

  it('handles partial lines (event split across writes)', async () => {
    const tail = new TranscriptTail(file);
    const events = [];
    tail.on('event', e => events.push(e));
    await tail.start();
    fs.writeFileSync(file, '{"type":"u","n":1}\n{"type":"u","n":');
    await new Promise(r => setTimeout(r, 100));
    fs.appendFileSync(file, '2}\n');
    await new Promise(r => setTimeout(r, 100));
    await tail.stop();
    expect(events.map(e => e.n)).toEqual([1, 2]);
  });

  it('emits parseError on malformed line, keeps tailing', async () => {
    const tail = new TranscriptTail(file);
    const events = [];
    const errors = [];
    tail.on('event', e => events.push(e));
    tail.on('parseError', e => errors.push(e));
    await tail.start();
    fs.writeFileSync(file, 'not json\n{"type":"a"}\n');
    await new Promise(r => setTimeout(r, 200));
    await tail.stop();
    expect(errors).toHaveLength(1);
    expect(events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
npx vitest run test/transcript-tail.test.js
```

- [ ] **Step 3: Implement**

```javascript
// lib/transcript-tail.js
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import chokidar from 'chokidar';

export class TranscriptTail extends EventEmitter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.offset = 0;
    this.buf = '';
    this.watcher = null;
  }

  async start() {
    this.watcher = chokidar.watch(this.filePath, {
      persistent: true,
      usePolling: false,
      awaitWriteFinish: false,
    });
    this.watcher.on('add', () => this._read());
    this.watcher.on('change', () => this._read());
    // If the file already exists, kick off an initial read.
    if (fs.existsSync(this.filePath)) this._read();
  }

  async stop() {
    if (this.watcher) await this.watcher.close();
    this.watcher = null;
  }

  _read() {
    let stat;
    try { stat = fs.statSync(this.filePath); } catch (_) { return; }
    if (stat.size < this.offset) {
      // File was truncated or replaced — restart from the top.
      this.offset = 0;
      this.buf = '';
    }
    if (stat.size === this.offset) return;
    const fd = fs.openSync(this.filePath, 'r');
    const len = stat.size - this.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, this.offset);
    fs.closeSync(fd);
    this.offset = stat.size;
    this.buf += buf.toString('utf8');
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.emit('event', JSON.parse(line));
      } catch (e) {
        this.emit('parseError', { line, error: e });
      }
    }
  }
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run test/transcript-tail.test.js
```

- [ ] **Step 5: Commit**

```bash
git add lib/transcript-tail.js test/transcript-tail.test.js
git commit -m "feat(bridge): JSONL transcript tail with chokidar"
```

### Task 1.5: `test/stub-claude.mjs` — fake `claude` binary for integration tests

**Files:**
- Create: `test/stub-claude.mjs`

This is a small program that mimics `claude` for tests of `interactive-session.js`:
- Reads stdin (looking for bracketed-paste sequences)
- Writes JSONL transcript to `<TRANSCRIPT_PATH>` (from env)
- Prints a fake TUI to stdout
- Recognises `/exit` to quit

- [ ] **Step 1: Write the stub**

```javascript
#!/usr/bin/env node
// test/stub-claude.mjs
import fs from 'node:fs';
import readline from 'node:readline';

const TX = process.env.TRANSCRIPT_PATH;
if (!TX) { console.error('TRANSCRIPT_PATH required'); process.exit(2); }

function emit(event) {
  fs.appendFileSync(TX, JSON.stringify(event) + '\n');
}

process.stdout.write('> ');  // fake prompt

let buf = '';
let inPaste = false;
process.stdin.on('data', chunk => {
  const s = chunk.toString();
  for (let i = 0; i < s.length; i++) {
    // Detect bracketed-paste start (ESC[200~) and end (ESC[201~)
    if (s.slice(i, i+6) === '\x1b[200~') { inPaste = true; i += 5; continue; }
    if (s.slice(i, i+6) === '\x1b[201~') { inPaste = false; i += 5; continue; }
    if (s[i] === '\r' || s[i] === '\n') {
      if (!inPaste && buf) {
        const text = buf; buf = '';
        if (text === '/exit') process.exit(0);
        emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
        emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${text}` }] } });
        emit({ type: 'result', subtype: 'success' });
        process.stdout.write(`echo: ${text}\n> `);
      }
    } else {
      buf += s[i];
    }
  }
});
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x test/stub-claude.mjs
```

- [ ] **Step 3: Smoke-test the stub manually**

```bash
TX=/tmp/stub-tx.jsonl; rm -f $TX
TRANSCRIPT_PATH=$TX node test/stub-claude.mjs &
PID=$!
sleep 0.2
printf '\x1b[200~hello\x1b[201~\r/exit\r' | nc -q1 -U /dev/null 2>/dev/null  # skip nc, just test via direct stdin write
wait $PID 2>/dev/null
cat $TX
```

Expected: a `user` event with `"text":"hello"`, an `assistant` event, a `result` event.

If the smoke-test is awkward to script, skip it and rely on the unit tests below.

- [ ] **Step 4: Commit**

```bash
git add test/stub-claude.mjs
git commit -m "test(bridge): stub claude binary for interactive-session tests"
```

### Task 1.6: `lib/interactive-session.js` — PTY spawn + lifecycle

**Files:**
- Create: `lib/interactive-session.js`
- Test: `test/interactive-session.test.js`

Wires together `pre-trust`, `pty-input`, `transcript-tail`. Exposes:
- `createInteractiveSession({ roomId, workdir, sessionId, claudeBin, claudeArgs, env, transcriptDir }) → InteractiveSession`
- `session.sendText(text)` — bracketed-paste + Enter
- `session.sendKeystroke(name)` — raw keystroke
- `session.on('event', cb)` — every transcript event
- `session.on('exit', cb)` — process exited
- `session.kill()`

- [ ] **Step 1: Write the failing test using the stub**

```javascript
// test/interactive-session.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInteractiveSession } from '../lib/interactive-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(__dirname, 'stub-claude.mjs');

describe('createInteractiveSession (integration with stub)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips a message through the stub', async () => {
    const txPath = path.join(dir, 'session.jsonl');
    const session = createInteractiveSession({
      roomId: 'room1',
      workdir: dir,
      sessionId: 'sid-test',
      claudeBin: process.execPath,
      claudeArgs: [STUB],
      env: { ...process.env, TRANSCRIPT_PATH: txPath },
      transcriptPath: txPath,
    });
    const events = [];
    session.on('event', e => events.push(e));
    await new Promise(r => setTimeout(r, 200));
    session.sendText('hello');
    await new Promise(r => setTimeout(r, 400));
    session.sendText('/exit');
    await new Promise(r => new Promise(r2 => session.on('exit', () => r2(r()))));
    expect(events.find(e => e.type === 'user')).toBeDefined();
    expect(events.find(e => e.type === 'assistant')).toBeDefined();
    expect(events.find(e => e.type === 'result')).toBeDefined();
  }, 10000);
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
npx vitest run test/interactive-session.test.js
```

- [ ] **Step 3: Implement**

```javascript
// lib/interactive-session.js
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import pty from 'node-pty';
import { ensureWorkspaceTrusted } from './pre-trust.js';
import { bracketedPaste, keystroke } from './pty-input.js';
import { TranscriptTail } from './transcript-tail.js';

function encodeProjectDir(workdir) {
  return workdir.replace(/\//g, '-');
}

export function transcriptPathFor(workdir, sessionId) {
  const encoded = encodeProjectDir(path.resolve(workdir));
  return path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

export class InteractiveSession extends EventEmitter {
  constructor({ roomId, workdir, sessionId, pty: ptyHandle, tail }) {
    super();
    this.roomId = roomId;
    this.workdir = workdir;
    this.sessionId = sessionId;
    this.pty = ptyHandle;
    this.tail = tail;
    this.alive = true;
    this.pty.onData(d => this.emit('pty-data', d));
    this.pty.onExit(({ exitCode }) => {
      this.alive = false;
      this.tail.stop().finally(() => this.emit('exit', exitCode));
    });
    this.tail.on('event', e => this.emit('event', e));
    this.tail.on('parseError', e => this.emit('parseError', e));
  }

  sendText(text) {
    if (!this.alive) return false;
    this.pty.write(bracketedPaste(text));
    return true;
  }

  sendKeystroke(name) {
    if (!this.alive) return false;
    this.pty.write(keystroke(name));
    return true;
  }

  sendRaw(bytes) {
    if (!this.alive) return false;
    this.pty.write(bytes);
    return true;
  }

  kill(signal = 'SIGTERM') {
    if (this.alive) this.pty.kill(signal);
  }
}

export function createInteractiveSession({
  roomId,
  workdir,
  sessionId,
  claudeBin = 'claude',
  claudeArgs = [],
  env = process.env,
  transcriptPath,
  cols = 120,
  rows = 40,
}) {
  ensureWorkspaceTrusted(workdir);
  const txPath = transcriptPath || transcriptPathFor(workdir, sessionId);
  const tail = new TranscriptTail(txPath);
  // Start tail BEFORE spawn so we don't miss the first events.
  tail.start();
  const ptyHandle = pty.spawn(claudeBin, claudeArgs, {
    name: 'xterm-256color',
    cwd: workdir,
    env,
    cols,
    rows,
  });
  return new InteractiveSession({ roomId, workdir, sessionId, pty: ptyHandle, tail });
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run test/interactive-session.test.js
```

If it fails because `node-pty` isn't installed yet (Task 1.1 only added to package.json), pause and run a scoped install:

```bash
# Done in a scratch dir to avoid disturbing the live node_modules:
mkdir -p /tmp/iv-deps && cd /tmp/iv-deps && cp ~/claude-matrix-bridge/package.json . && npm install --omit=dev node-pty chokidar
# Then symlink into the bridge's node_modules. The bridge service has already loaded its modules into memory; adding new ones to node_modules will not affect it.
ln -s /tmp/iv-deps/node_modules/node-pty ~/claude-matrix-bridge/node_modules/node-pty
ln -s /tmp/iv-deps/node_modules/chokidar ~/claude-matrix-bridge/node_modules/chokidar
```

Re-run the test. (Phase 5 replaces this with a proper `npm install` at cutover.)

- [ ] **Step 5: Commit**

```bash
git add lib/interactive-session.js test/interactive-session.test.js
git commit -m "feat(bridge): interactive session driver (PTY + transcript tail)"
```

---

## Phase 2 — Hooks for turn-end and ExitPlanMode

### Task 2.1: `hooks/stop-notify.sh` — Stop hook

**Files:**
- Create: `hooks/stop-notify.sh`

Mirrors the pattern of `hooks/compact-notify.sh`.

- [ ] **Step 1: Write the script**

```bash
cat > hooks/stop-notify.sh <<'EOF'
#!/bin/bash
# Stop hook — notifies the matrix bridge that an assistant turn has finished.
INPUT=$(cat)
SID=$(echo "$INPUT" | jq -r '.session_id // empty')
TX=$(echo "$INPUT" | jq -r '.transcript_path // empty')
PORT="${MATRIX_BRIDGE_API_PORT:-9802}"
curl -s -X POST "http://127.0.0.1:${PORT}/turn-end" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SID\",\"transcript_path\":\"$TX\"}" > /dev/null
exit 0
EOF
chmod +x hooks/stop-notify.sh
```

NOTE: if Task 0.1 found the hook payload uses different field names than `session_id` / `transcript_path`, update both this script and the bridge handler in Task 2.3.

- [ ] **Step 2: Commit**

```bash
git add hooks/stop-notify.sh
git commit -m "feat(bridge): Stop hook posts turn-end to bridge HTTP API"
```

### Task 2.2: `hooks/exit-plan-decision.sh` — PreToolUse hook for ExitPlanMode

**Files:**
- Create: `hooks/exit-plan-decision.sh`

This hook BLOCKS until the bridge HTTP API returns a decision (the bridge will hold the response open until the user replies on Matrix). Returns a `hookSpecificOutput` JSON with `permissionDecision: "allow" | "deny"`.

- [ ] **Step 1: Write the script**

```bash
cat > hooks/exit-plan-decision.sh <<'EOF'
#!/bin/bash
# PreToolUse hook for ExitPlanMode — blocks on bridge HTTP until the user decides.
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
if [ "$TOOL" != "ExitPlanMode" ]; then
  # Not our tool — emit empty hookSpecificOutput, let claude proceed.
  echo '{}'
  exit 0
fi
SID=$(echo "$INPUT" | jq -r '.session_id // empty')
TUID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')
PLAN=$(echo "$INPUT" | jq -r '.tool_input.plan // empty')
PORT="${MATRIX_BRIDGE_API_PORT:-9802}"
RESP=$(curl -s --max-time 1800 -X POST "http://127.0.0.1:${PORT}/plan-decision" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg sid "$SID" --arg tuid "$TUID" --arg plan "$PLAN" '{session_id:$sid,tool_use_id:$tuid,plan:$plan}')")
DECISION=$(echo "$RESP" | jq -r '.decision // "deny"')
REASON=$(echo "$RESP" | jq -r '.reason // ""')
jq -nc --arg d "$DECISION" --arg r "$REASON" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: $d, permissionDecisionReason: $r}}'
exit 0
EOF
chmod +x hooks/exit-plan-decision.sh
```

- [ ] **Step 2: Commit**

```bash
git add hooks/exit-plan-decision.sh
git commit -m "feat(bridge): PreToolUse hook for ExitPlanMode with bridge HTTP gate"
```

### Task 2.3: Add `/turn-end` and `/plan-decision` HTTP endpoints to bridge

**Files:**
- Modify: `index.js` (in the Express app setup; do NOT touch `createSession` yet)

- [ ] **Step 1: Find the Express app definition**

```bash
grep -n "app.post\|app.get\|express()" ~/claude-matrix-bridge/index.js | head -10
```

Note the line where existing handlers are registered. The new handlers go right after.

- [ ] **Step 2: Add handlers**

```javascript
// Anywhere in index.js after the Express app is set up and the `sessions` map is defined.

// Map: session_id (claude UUID) -> roomId. Maintained by interactive-session wiring (Phase 4).
const claudeSessionToRoom = new Map();

// Map: tool_use_id -> { resolve, reject, timer } pending plan-decision callers.
const pendingPlanDecisions = new Map();

app.post('/turn-end', express.json(), (req, res) => {
  const { session_id } = req.body || {};
  const roomId = claudeSessionToRoom.get(session_id);
  if (!roomId) {
    res.status(404).json({ error: 'unknown session' });
    return;
  }
  const session = sessions.get(roomId);
  if (session && session.onTurnEnd) session.onTurnEnd();
  res.json({ ok: true });
});

app.post('/plan-decision', express.json(), (req, res) => {
  const { session_id, tool_use_id, plan } = req.body || {};
  const roomId = claudeSessionToRoom.get(session_id);
  if (!roomId) {
    res.status(404).json({ decision: 'deny', reason: 'unknown session' });
    return;
  }
  const session = sessions.get(roomId);
  if (!session || !session.requestPlanDecision) {
    res.json({ decision: 'deny', reason: 'no session handler' });
    return;
  }
  // session.requestPlanDecision is set up in Phase 4; it returns a Promise that
  // resolves to { decision, reason } once the user replies on Matrix.
  const timer = setTimeout(() => {
    pendingPlanDecisions.delete(tool_use_id);
    res.json({ decision: 'deny', reason: 'timeout waiting for user' });
  }, 1740 * 1000); // 29 min — leaves slack under curl's 1800s
  pendingPlanDecisions.set(tool_use_id, { resolve: (d) => { clearTimeout(timer); res.json(d); }, plan });
  session.requestPlanDecision(tool_use_id, plan);
});

// Expose so Phase 4 wiring can resolve pending decisions.
export { claudeSessionToRoom, pendingPlanDecisions };
```

(Adjust the `export` to fit `index.js`'s module shape — it's currently CommonJS-style top-level code; if there are no exports yet, add the maps to a singleton object instead.)

- [ ] **Step 3: Syntax-check**

```bash
node --check ~/claude-matrix-bridge/index.js
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(bridge): add /turn-end and /plan-decision HTTP endpoints"
```

---

## Phase 3 — Interactive prompt handler

This is the safety net for any TUI dialog the hook system can't intercept. The detector is heuristic — it must be conservative (false negatives are OK, false positives that spam Matrix are not).

### Task 3.1: `lib/prompt-detector.js` — ANSI-stripped screen tracker

**Files:**
- Create: `lib/prompt-detector.js`
- Test: `test/prompt-detector.test.js`

Strategy:
1. Maintain a rolling buffer of the last N bytes of PTY output.
2. After **300ms of silence**, run the classifier on the stripped buffer.
3. Classifier looks for known shapes:
   - **Yes/No:** trailing line matches `/\[y\/n\]/i` or `(y\/N)`
   - **Numbered:** trailing block of lines like `^\s*\d+[.)]\s+.+$` followed by a prompt
   - **Lettered:** same with `[a-z][.)]`
   - **Arrow-menu:** lines with an indicator like `> ` or `❯ ` marking a current selection; lines containing the same prefix beneath
4. Emit `{ kind, question, options, raw }`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/prompt-detector.test.js
import { describe, it, expect } from 'vitest';
import { classifyScreen } from '../lib/prompt-detector.js';

describe('classifyScreen', () => {
  it('detects y/n prompt', () => {
    const screen = 'Continue with this plan? [y/N]';
    const r = classifyScreen(screen);
    expect(r.kind).toBe('yes-no');
    expect(r.options).toEqual([{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }]);
  });

  it('detects numbered selection', () => {
    const screen = [
      'Choose a model:',
      '  1) Sonnet',
      '  2) Opus',
      '  3) Haiku',
      '>',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r.kind).toBe('numbered');
    expect(r.options).toHaveLength(3);
    expect(r.options[0]).toEqual({ key: '1', label: 'Sonnet' });
  });

  it('detects arrow-menu via marker', () => {
    const screen = [
      'Pick one:',
      '❯ Option A',
      '  Option B',
      '  Option C',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r.kind).toBe('arrow-menu');
    expect(r.options.map(o => o.label)).toEqual(['Option A', 'Option B', 'Option C']);
    expect(r.options[0].selected).toBe(true);
  });

  it('returns null when screen looks like normal output', () => {
    const screen = 'Working on it...\nDone.\n> ';
    expect(classifyScreen(screen)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run test/prompt-detector.test.js
```

- [ ] **Step 3: Implement**

```javascript
// lib/prompt-detector.js
import { EventEmitter } from 'node:events';

const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-_]/g;
const CR_RE = /\r(?!\n)/g;

export function stripAnsi(s) {
  return s.replace(ANSI_RE, '').replace(CR_RE, '');
}

export function classifyScreen(screen) {
  const lines = screen.split('\n').map(l => l.trimEnd());
  const tail = lines.slice(-20).join('\n');

  // Yes/No
  const yn = tail.match(/\[\s*y\s*\/\s*n\s*\]/i) || tail.match(/\(\s*y\s*\/\s*N\s*\)/i);
  if (yn) {
    return {
      kind: 'yes-no',
      question: tail.split('\n').filter(Boolean).slice(-3).join(' '),
      options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }],
    };
  }

  // Numbered selection — at least two consecutive lines matching ^ *\d+[.)] .+
  const numbered = [];
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (m) numbered.push({ key: m[1], label: m[2] });
    else if (numbered.length >= 2) break;
    else numbered.length = 0;
  }
  if (numbered.length >= 2) {
    const idx = lines.findIndex(l => /^\s*\d+[.)]\s+/.test(l));
    const question = lines.slice(Math.max(0, idx - 2), idx).join(' ').trim();
    return { kind: 'numbered', question, options: numbered };
  }

  // Lettered selection
  const lettered = [];
  for (const line of lines) {
    const m = line.match(/^\s*\(?([a-z])\)?[.)]\s+(.+)$/i);
    if (m) lettered.push({ key: m[1].toLowerCase(), label: m[2] });
    else if (lettered.length >= 2) break;
    else lettered.length = 0;
  }
  if (lettered.length >= 2) {
    const idx = lines.findIndex(l => /^\s*\(?[a-z]\)?[.)]\s+/i.test(l));
    const question = lines.slice(Math.max(0, idx - 2), idx).join(' ').trim();
    return { kind: 'lettered', question, options: lettered };
  }

  // Arrow menu — a line with selection marker followed by sibling lines.
  const markerRe = /^(\s*)([❯>▶►])\s+(.+)$/;
  const idx = lines.findIndex(l => markerRe.test(l));
  if (idx >= 0) {
    const m = lines[idx].match(markerRe);
    const indent = m[1].length;
    const items = [];
    items.push({ label: m[3], selected: true });
    for (let i = idx + 1; i < lines.length; i++) {
      const sm = lines[i].match(/^(\s*)(.+)$/);
      if (!sm || sm[1].length < indent) break;
      const label = sm[2].replace(/^[❯>▶►]\s*/, '');
      if (!label.trim()) break;
      items.push({ label, selected: false });
    }
    if (items.length >= 2) {
      const question = lines.slice(Math.max(0, idx - 2), idx).join(' ').trim();
      return { kind: 'arrow-menu', question, options: items };
    }
  }

  return null;
}

export class PromptDetector extends EventEmitter {
  constructor({ idleMs = 300, bufferLimit = 16384 } = {}) {
    super();
    this.idleMs = idleMs;
    this.bufferLimit = bufferLimit;
    this.buf = '';
    this.timer = null;
    this.lastEmitted = null;
  }

  feed(chunk) {
    this.buf += chunk;
    if (this.buf.length > this.bufferLimit) {
      this.buf = this.buf.slice(-this.bufferLimit);
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._check(), this.idleMs);
  }

  _check() {
    const screen = stripAnsi(this.buf);
    const r = classifyScreen(screen);
    if (!r) return;
    // De-dupe — don't emit the same prompt twice.
    const sig = `${r.kind}:${r.question}:${r.options.map(o => o.label).join('|')}`;
    if (sig === this.lastEmitted) return;
    this.lastEmitted = sig;
    this.emit('prompt', r);
  }

  reset() {
    this.buf = '';
    this.lastEmitted = null;
  }
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run test/prompt-detector.test.js
```

- [ ] **Step 5: Commit**

```bash
git add lib/prompt-detector.js test/prompt-detector.test.js
git commit -m "feat(bridge): heuristic interactive-prompt detector"
```

### Task 3.2: Wire `PromptDetector` into `InteractiveSession`

**Files:**
- Modify: `lib/interactive-session.js`
- Modify: `test/interactive-session.test.js`

- [ ] **Step 1: Add detector to the session**

In `lib/interactive-session.js`, inside the `InteractiveSession` constructor, after `this.pty.onData(...)`:

```javascript
import { PromptDetector } from './prompt-detector.js';

// ... inside constructor:
this.detector = new PromptDetector();
this.pty.onData(d => {
  this.detector.feed(d);
  this.emit('pty-data', d);
});
this.detector.on('prompt', p => this.emit('prompt', p));
```

Add a `respondToPrompt({ kind, key })` method that maps to keystrokes:

```javascript
respondToPrompt({ kind, key }) {
  if (!this.alive) return false;
  if (kind === 'yes-no') return this.sendKeystroke(key) && this.sendKeystroke('enter');
  if (kind === 'numbered' || kind === 'lettered') return this.sendKeystroke(key) && this.sendKeystroke('enter');
  if (kind === 'arrow-menu') {
    // key is the option index; navigate from current selection (assumed 0).
    const idx = parseInt(key, 10);
    for (let i = 0; i < idx; i++) this.sendKeystroke('down');
    return this.sendKeystroke('enter');
  }
  return false;
}
```

- [ ] **Step 2: Add a test that the stub fakes a prompt and we respond to it**

Extend `test/stub-claude.mjs` to emit a fake prompt when sent the text `__prompt__`:

```javascript
// In the if (text === '/exit') block area, add:
if (text === '__prompt__') {
  process.stdout.write('\nContinue? [y/N] ');
  // wait for a single byte
  process.stdin.once('data', b => {
    const k = b.toString()[0];
    process.stdout.write('\n> ');
    if (k === 'y') process.stdout.write('confirmed\n> ');
  });
  return;
}
```

In `test/interactive-session.test.js`:

```javascript
it('detects and responds to a yes/no prompt', async () => {
  const txPath = path.join(dir, 'session.jsonl');
  const session = createInteractiveSession({ /* ... same setup ... */ });
  const prompts = [];
  session.on('prompt', p => prompts.push(p));
  await new Promise(r => setTimeout(r, 200));
  session.sendText('__prompt__');
  await new Promise(r => setTimeout(r, 600)); // wait for idle
  expect(prompts).toHaveLength(1);
  expect(prompts[0].kind).toBe('yes-no');
  session.respondToPrompt({ kind: 'yes-no', key: 'y' });
  await new Promise(r => setTimeout(r, 400));
  session.sendText('/exit');
});
```

- [ ] **Step 3: Run, verify pass**

```bash
npx vitest run test/interactive-session.test.js
```

- [ ] **Step 4: Commit**

```bash
git add lib/interactive-session.js test/interactive-session.test.js test/stub-claude.mjs
git commit -m "feat(bridge): wire prompt detector into interactive session"
```

---

## Phase 4 — Bridge integration behind feature flag

### Task 4.1: Branch `createSession` on `MATRON_INTERACTIVE_MODE`

**Files:**
- Modify: `index.js`

- [ ] **Step 1: At the top of `index.js`, read the env flag**

Add near other env reads (around the top of the file):

```javascript
const INTERACTIVE_MODE = process.env.MATRON_INTERACTIVE_MODE === '1';
```

- [ ] **Step 2: At the top of `createSession`, branch to a new helper**

```javascript
function createSession(roomId, workdir, resumeSessionId) {
  if (INTERACTIVE_MODE) {
    return createInteractiveSessionForRoom(roomId, workdir, resumeSessionId);
  }
  // ... existing --print code unchanged ...
}
```

- [ ] **Step 3: Implement `createInteractiveSessionForRoom`**

In a new section of `index.js` (or factor to a small module — keep inline for now to minimise plumbing):

```javascript
import { createInteractiveSession, transcriptPathFor } from './lib/interactive-session.js';
import crypto from 'node:crypto';

function createInteractiveSessionForRoom(roomId, workdir, resumeSessionId) {
  const cwd = expandHome(workdir || DEFAULT_WORKDIR);
  const persistedForRoom = getPersistedSession(roomId);
  const showBashOutputAtSpawn = persistedForRoom?.showBashOutput !== false;
  const sessionId = resumeSessionId || crypto.randomUUID();

  const settings = {
    hooks: {
      PreCompact: [{
        hooks: [{ type: 'command', command: path.join(__dirname, 'hooks', 'compact-notify.sh'), timeout: 5 }],
      }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: path.join(__dirname, 'hooks', 'matron-bash-tee.sh') }] },
        { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: path.join(__dirname, 'hooks', 'exit-plan-decision.sh'), timeout: 1800 }] },
      ],
      Stop: [{
        hooks: [{ type: 'command', command: path.join(__dirname, 'hooks', 'stop-notify.sh'), timeout: 10 }],
      }],
    },
  };

  const claudeArgs = [
    '--session-id', sessionId,
    '--dangerously-skip-permissions',
    '--disallowed-tools', 'AskUserQuestion',
    '--append-system-prompt', BRIDGE_SYSTEM_PROMPT,
    '--mcp-config', MCP_CONFIG_PATH,
    '--settings', JSON.stringify(settings),
  ];
  if (resumeSessionId) claudeArgs.push('--resume', resumeSessionId);

  const nodeBinDir = path.dirname(process.execPath);
  const existingPath = process.env.PATH || '';
  const pathWithNode = existingPath.split(':').includes(nodeBinDir) ? existingPath : `${nodeBinDir}:${existingPath}`;

  const ivSession = createInteractiveSession({
    roomId,
    workdir: cwd,
    sessionId,
    claudeArgs,
    env: {
      ...process.env,
      PATH: pathWithNode,
      CLAUDECODE: '',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
      BRIDGE_ROOM_ID: roomId,
      MATRIX_BRIDGE_API_PORT: String(API_PORT),
      MATRON_BASH_TEE_ENABLED: showBashOutputAtSpawn ? '1' : '0',
    },
  });

  claudeSessionToRoom.set(sessionId, roomId);

  // Bridge session object — same shape as the --print session so the rest of
  // the bridge keeps working. Bridge events to the existing handleClaudeEvent
  // so all downstream logic (Matrix posting, queue management, etc.) is unchanged.
  const session = {
    proc: null,               // no Node process to expose; iv-mode uses pty internally
    iv: ivSession,
    roomId,
    workdir: cwd,
    responseBuffer: '',
    sendCallback: null,
    pendingPlan: null,
    pendingPlanDenialId: null,
    sendHtml: null,
    showWorking: false,
    showBashOutput: showBashOutputAtSpawn,
    alive: true,
    startedAt: Date.now(),
    restartCount: 0,
    claudeSessionId: sessionId,
    busy: false,
    lineBuf: '',
    toolCalls: [],
    waitingForAnswer: null,
    originRoomId: null,
    firstMessageCaptured: false,
    initData: null,
    totalUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, cost_usd: 0 },
    turnCount: 0,
    chatHistory: [],
    pinnedSummaryEventId: null,
    pinnedSummaryText: '',
    pendingWelcome: true,
  };

  ivSession.on('event', e => handleClaudeEvent(session, e));
  ivSession.on('prompt', p => handleInteractivePrompt(session, p));
  ivSession.on('exit', exitCode => {
    session.alive = false;
    flushResponse(session);
    claudeSessionToRoom.delete(sessionId);
    // Reuse existing restart logic — extract to a shared helper if needed.
    handleSessionExit(session, exitCode, cwd);
  });

  // Wire turn-end + plan-decision callbacks the HTTP endpoints expect.
  session.onTurnEnd = () => {
    session.busy = false;
    if (session.typingInterval) { clearInterval(session.typingInterval); session.typingInterval = null; }
    // The current --print path uses the `result` event for this. handleClaudeEvent
    // already does the right thing when it sees a `result` event from the transcript,
    // so onTurnEnd is a no-op safety net for cases where the result event is missing.
  };

  session.requestPlanDecision = (toolUseId, planText) => {
    // Send plan to Matrix and wait for user decision.
    // Use the bridge's existing sendHtml + queue mechanism.
    const decisionPromise = postPlanToMatrix(session, planText);
    decisionPromise.then(d => {
      const pending = pendingPlanDecisions.get(toolUseId);
      if (pending) {
        pendingPlanDecisions.delete(toolUseId);
        pending.resolve({ decision: d.approved ? 'allow' : 'deny', reason: d.reason || '' });
      }
    });
  };

  // Override the stream-json `stdin.write` calls in sendToSession / answer-injection
  // by switching on `session.iv` presence — see Task 4.2.

  sessions.set(roomId, session);
  return session;
}
```

`handleSessionExit` is a small extraction of the existing `proc.on('close', ...)` body — pulled out so both code paths can call it. `postPlanToMatrix` is a new helper that uses `session.sendHtml` to post the plan as a Matrix multiple-choice (approve / deny) message and returns a Promise resolved by the user's reply.

- [ ] **Step 4: Syntax-check**

```bash
node --check ~/claude-matrix-bridge/index.js
```

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(bridge): MATRON_INTERACTIVE_MODE branch in createSession"
```

### Task 4.2: Switch `sendToSession` / answer injection to PTY when in iv-mode

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Locate the three `stdin.write` call sites**

```bash
grep -n "proc.stdin.write" ~/claude-matrix-bridge/index.js
```

Expected: lines around 542, 1030, 2589.

- [ ] **Step 2: At each call site, branch on `session.iv`**

For the line ~1030 case (`sendToSession`):

```javascript
function sendToSession(session, contentBlocks) {
  if (!session.alive) return false;
  session.responseBuffer = '';
  session.toolCalls = [];
  session.busy = true;
  if (session.typingInterval) clearInterval(session.typingInterval);
  session.typingInterval = startTyping(session.roomId);

  if (session.iv) {
    // Interactive mode: type text blocks; non-text blocks (images) are not
    // currently supportable via PTY — log and drop, or send a placeholder.
    const text = contentBlocks
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n\n');
    if (contentBlocks.some(b => b.type !== 'text')) {
      debug('iv-mode: dropping non-text content blocks (not yet supported)');
    }
    session.iv.sendText(text);
    if (session.resetTimeout) session.resetTimeout();
    return true;
  }

  // ... existing stream-json path unchanged ...
}
```

For the line ~542 case (answer to pending question): the question flow uses `ask-user` MCP and the MCP server returns the answer directly — this stdin.write is for an alternate path (`AskUserQuestion`-like). Audit whether it runs in iv-mode at all. If yes, branch to typing the answer; if no, leave the print-mode path alone (it's only reached when the iv flag is off).

For the line ~2589 case (ExitPlanMode approval): in iv-mode this path is handled by the hook (Task 2.2) — the bridge sets the decision via `pendingPlanDecisions.get(toolUseId).resolve(...)`. The existing stdin.write code is reached only in print mode. Audit and guard with `if (!session.iv) { ...existing stdin.write... }`.

- [ ] **Step 3: Syntax-check**

```bash
node --check ~/claude-matrix-bridge/index.js
```

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(bridge): route input through PTY when iv-mode active"
```

### Task 4.3: Surface interactive prompts to Matrix via `handleInteractivePrompt`

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Implement `handleInteractivePrompt`**

```javascript
async function handleInteractivePrompt(session, prompt) {
  if (!session.sendHtml) return;
  const lines = [`<b>Claude is waiting for input:</b>`, ''];
  if (prompt.question) lines.push(escapeHtml(prompt.question));
  lines.push('');
  prompt.options.forEach((opt, i) => {
    const num = i + 1;
    lines.push(`<b>${num}.</b> ${escapeHtml(opt.label)}`);
  });
  lines.push('');
  lines.push(`<i>Reply with the option number (1, 2, …) or the option letter / "y" / "n".</i>`);
  const html = lines.join('<br/>');
  const plain = lines.map(l => l.replace(/<[^>]+>/g, '')).join('\n');
  session.sendHtml(plain, html);

  session.pendingInteractivePrompt = prompt;
}

// In the message-handling code (where user messages come in from Matrix):
// before the normal sendToSession path, check pendingInteractivePrompt.
function maybeResolveInteractivePrompt(session, userText) {
  const p = session.pendingInteractivePrompt;
  if (!p) return false;
  const trimmed = userText.trim().toLowerCase();
  let response = null;
  if (p.kind === 'yes-no') {
    if (/^(y|yes|1)$/.test(trimmed)) response = { kind: 'yes-no', key: 'y' };
    else if (/^(n|no|2)$/.test(trimmed)) response = { kind: 'yes-no', key: 'n' };
  } else if (p.kind === 'numbered' || p.kind === 'lettered' || p.kind === 'arrow-menu') {
    const n = parseInt(trimmed, 10);
    if (!isNaN(n) && n >= 1 && n <= p.options.length) {
      const opt = p.options[n - 1];
      response = { kind: p.kind, key: p.kind === 'arrow-menu' ? String(n - 1) : opt.key };
    } else if (p.kind === 'lettered' && /^[a-z]$/.test(trimmed)) {
      response = { kind: 'lettered', key: trimmed };
    }
  }
  if (!response) {
    session.sendHtml('Sorry, that\'s not a valid choice. Please reply with the option number.', null);
    return true; // consumed but invalid — don't pass to claude
  }
  session.pendingInteractivePrompt = null;
  session.iv.respondToPrompt(response);
  return true;
}
```

In the user-message handler (find it via `grep -n "sendTextToSession\|sendToSession" index.js`), add a guard at the top:

```javascript
if (session.iv && maybeResolveInteractivePrompt(session, text)) return;
```

- [ ] **Step 2: Syntax-check**

```bash
node --check ~/claude-matrix-bridge/index.js
```

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat(bridge): forward interactive prompts to Matrix and route replies"
```

---

## Phase 5 — Validation and cutover

### Task 5.1: Local validation under iv-mode

- [ ] **Step 1: Install new deps properly**

This is the first step that affects the live `node_modules`. Do it during a quiet period.

```bash
cd ~/claude-matrix-bridge && npm install
```

The running bridge service has its current modules in memory; new files in `node_modules` won't affect it. But if `npm install` rewrites existing module files, it could.

To verify safety beforehand:

```bash
npm install --dry-run 2>&1 | head -40
```

Look at the list of changed packages. If only `node-pty` and `chokidar` are added (no existing modules updated), proceed. Otherwise pin existing deps in package.json before installing.

- [ ] **Step 2: Run the full test suite**

```bash
cd ~/claude-matrix-bridge && npm test
```

Expected: all tests pass, including the new ones.

- [ ] **Step 3: Spin up a parallel bridge instance in iv-mode on a different port and Matrix bot**

Do NOT restart the live bridge. Start a second instance pointing at a test Matrix user (or just bypass and drive directly):

```bash
MATRON_INTERACTIVE_MODE=1 \
MATRIX_BRIDGE_API_PORT=9803 \
MATRIX_VIEWER_PORT=9804 \
MATRIX_USER_ID=@bridge-test:yearbooks.be \
ACCESS_TOKEN=... \
node index.js
```

- [ ] **Step 4: Send a test message via Matrix to the test bot; observe**

Verify:
- Test bot creates an interactive `claude` session in PTY mode
- Transcript appears at `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`
- Events flow to the parallel bridge, are posted to Matrix
- `/cost` (if invokable) reports plan billing, not API dollars

- [ ] **Step 5: Test plan-mode flow**

In the test session, ask claude to "make a plan to refactor X". When it calls `ExitPlanMode`:
- Bridge posts plan to Matrix with approve/deny options
- Reply "approve"; verify the hook returns `permissionDecision: allow` and claude proceeds.

- [ ] **Step 6: Test interactive-prompt handler**

Trigger a TUI dialog by, e.g., asking claude to run a slash command that prompts (`/compact` typically asks confirmation). Verify the bridge posts the prompt to Matrix and reply selection translates to a keystroke.

### Task 5.2: Cutover

- [ ] **Step 1: Stop the parallel test instance**

- [ ] **Step 2: Flip the live service env to iv-mode**

```bash
sudo systemctl edit claude-matrix-bridge.service
# Add under [Service]:
#   Environment=MATRON_INTERACTIVE_MODE=1
sudo systemctl daemon-reload
```

- [ ] **Step 3: Restart the service**

```bash
sudo systemctl restart claude-matrix-bridge.service
sudo systemctl status claude-matrix-bridge.service
```

⚠️ This terminates any active Claude Code sessions connected through the bridge — including any session the user is currently conversing in. Coordinate with the user before this step.

- [ ] **Step 4: Sanity-check active rooms**

Send a test message in each active room. Verify claude responds.

- [ ] **Step 5: Monitor for a day, then commit cutover note**

```bash
git commit --allow-empty -m "chore(bridge): cutover to interactive mode in production"
```

### Task 5.3: Remove `--print` code path (deferred — open a follow-up issue, don't do it in this plan)

After two weeks of stable iv-mode, the dead `--print` branch in `createSession` and the stream-json input/output handling can be deleted. Track as a separate plan; this one's done.

---

## Self-review checklist

**Spec coverage:**
- ✅ PTY-driven `claude` session per room — Phase 1
- ✅ Tail JSONL transcript instead of stdout parsing — Tasks 1.4, 1.6
- ✅ Skip workspace trust via pre-write — Task 1.2
- ✅ Bracketed-paste user messages — Task 1.3
- ✅ `Stop` hook for turn end — Tasks 2.1, 2.3
- ✅ `PreToolUse:ExitPlanMode` hook — Tasks 2.2, 2.3, 4.1
- ✅ Interactive prompt detection + Matrix routing — Tasks 3.1, 3.2, 4.3
- ✅ Feature flag for safe rollout — Task 4.1
- ✅ Non-destructive until Phase 5 — entire plan structure

**Open risks:**
- Phase 0 tasks gate the plan: `Stop` hook name, `--session-id` in interactive mode, plan billing for PTY sessions, bracketed-paste behaviour. Confirm all four before Phase 1.
- The matronhq `chat.matron` namespace refactor (in this pull) means restart-time state migration may be needed independently of this work; verify in Phase 5 Step 3.
- `node-pty` is a native dep — rebuild may fail on systems without build tools. The dev box has them; verify with `npm install --dry-run`.
- The `requestPlanDecision`/`postPlanToMatrix` glue (Task 4.1) leans on Matrix message-handling code that this plan does not exhaustively spell out — author should read the existing plan-mode flow in `index.js` (search `pendingPlan`) and replicate the UX.
