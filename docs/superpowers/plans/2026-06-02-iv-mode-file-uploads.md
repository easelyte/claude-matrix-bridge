# Interactive-mode File Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make file uploads work deliberately in the bridge's interactive (iv) mode by saving each upload outside the repo and typing its absolute path into the PTY for Claude to `Read`.

**Architecture:** Add a small pure-helper module `lib/iv-uploads.js` (upload dir, room-id sanitization, filename/caption resolution, PTY annotation text). Branch `buildMediaContentBlocks()` in `index.js`: when `session.iv` is set, save the file to `~/.claude-matrix-uploads/<room>/` and return a single text block annotating the path; SDK (print) mode is left unchanged. Because the returned blocks are text-only, the existing iv-branch in `sendToSession()` and the queue/flush path work without modification.

**Tech Stack:** Node.js (ESM, `"type": "module"`), vitest, node-pty. No new dependencies.

---

## File Structure

- **Create:** `lib/iv-uploads.js` — pure helpers: `ivUploadsRoot()`, `sanitizeRoomId()`, `ivUploadDir()`, `resolveUploadMeta()`, `ivUploadAnnotation()`. One responsibility: deciding *where* an iv upload is saved and *what text* is typed for it. No network, minimal fs (only `mkdir` inside `ivUploadDir`).
- **Create:** `test/iv-uploads.test.js` — vitest unit tests for the helpers.
- **Modify:** `index.js` — import the helpers; add the `session.iv` branch inside `buildMediaContentBlocks()` (currently index.js:2634-2686).
- **Modify:** `package.json` — add `lib/iv-uploads.js` to the `check` script's `node --check` chain.

### Why tests stop at the lib boundary

`index.js` is a monolithic entry script that boots the whole bridge on import (Matrix client, timers, etc.), so it is not import-safe for unit tests and exports nothing. All logic that can be tested in isolation lives in `lib/iv-uploads.js` and is covered there. The `index.js` wiring is verified by `npm run check` (`node --check`), `npm run lint`, and the reasoning that the new branch returns text-only blocks (which the existing tested code paths already handle).

---

## Task 1: Pure helper module `lib/iv-uploads.js`

**Files:**
- Create: `lib/iv-uploads.js`
- Test: `test/iv-uploads.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/iv-uploads.test.js`:

```js
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ivUploadsRoot,
  sanitizeRoomId,
  ivUploadDir,
  resolveUploadMeta,
  ivUploadAnnotation,
} from '../lib/iv-uploads.js';

describe('sanitizeRoomId', () => {
  it('replaces filesystem-unsafe characters with underscores', () => {
    expect(sanitizeRoomId('!abc123:server.com')).toBe('_abc123_server_com');
  });

  it('keeps letters, digits, dashes and underscores', () => {
    expect(sanitizeRoomId('Room-1_ok')).toBe('Room-1_ok');
  });

  it('caps length at 80 characters', () => {
    expect(sanitizeRoomId('a'.repeat(200))).toHaveLength(80);
  });
});

describe('ivUploadsRoot / ivUploadDir', () => {
  it('roots uploads at ~/.claude-matrix-uploads', () => {
    expect(ivUploadsRoot()).toBe(path.join(os.homedir(), '.claude-matrix-uploads'));
  });

  it('returns a per-room dir path without creating it when mkdir is false', () => {
    const dir = ivUploadDir('!room:srv', { mkdir: false });
    expect(dir).toBe(path.join(os.homedir(), '.claude-matrix-uploads', '_room_srv'));
  });

  it('creates the directory on demand', () => {
    const prevHome = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ivup-'));
    try {
      process.env.HOME = tmp;
      const dir = ivUploadDir('!room:srv');
      expect(fs.existsSync(dir)).toBe(true);
      expect(dir.startsWith(tmp)).toBe(true);
    } finally {
      process.env.HOME = prevHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('resolveUploadMeta', () => {
  it('uses body as filename when there is no caption', () => {
    expect(resolveUploadMeta({ body: 'photo.png' })).toEqual({
      filename: 'photo.png',
      caption: null,
    });
  });

  it('uses filename and treats differing body as the caption', () => {
    expect(resolveUploadMeta({ filename: 'photo.png', body: 'look at this' })).toEqual({
      filename: 'photo.png',
      caption: 'look at this',
    });
  });

  it('returns no caption when filename equals body', () => {
    expect(resolveUploadMeta({ filename: 'a.png', body: 'a.png' })).toEqual({
      filename: 'a.png',
      caption: null,
    });
  });

  it('falls back to "file" when nothing is provided', () => {
    expect(resolveUploadMeta({})).toEqual({ filename: 'file', caption: null });
  });
});

describe('ivUploadAnnotation', () => {
  it('annotates an image path', () => {
    expect(ivUploadAnnotation({ msgtype: 'm.image', savePath: '/u/x.png', caption: null }))
      .toBe('[The user uploaded an image: /u/x.png]');
  });

  it('annotates a file path', () => {
    expect(ivUploadAnnotation({ msgtype: 'm.file', savePath: '/u/x.bin', caption: null }))
      .toBe('[The user uploaded a file: /u/x.bin]');
  });

  it('puts the caption first, annotation second', () => {
    expect(ivUploadAnnotation({ msgtype: 'm.image', savePath: '/u/x.png', caption: 'hi' }))
      .toBe('hi\n\n[The user uploaded an image: /u/x.png]');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- iv-uploads`
Expected: FAIL — `Failed to resolve import "../lib/iv-uploads.js"` (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `lib/iv-uploads.js`:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Root directory for files uploaded via Matrix in interactive mode. Kept
// OUTSIDE any session workdir so uploads never clutter a project/git tree.
export function ivUploadsRoot() {
  return path.join(os.homedir(), '.claude-matrix-uploads');
}

// Turn a Matrix room id into a single safe path segment. Mirrors the
// sanitization pattern used for PTY dump paths in lib/interactive-session.js.
export function sanitizeRoomId(roomId) {
  return String(roomId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

// Per-room upload directory. Created on demand unless mkdir is false.
export function ivUploadDir(roomId, { mkdir = true } = {}) {
  const dir = path.join(ivUploadsRoot(), sanitizeRoomId(roomId));
  if (mkdir) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Resolve the real filename and optional caption from a Matrix media event's
// content. When a caption is attached, `filename` holds the real name and
// `body` holds the caption; with no caption, `body` is the filename.
export function resolveUploadMeta(content) {
  const filename = content.filename || content.body || 'file';
  const caption =
    content.filename && content.body && content.body !== content.filename
      ? content.body
      : null;
  return { filename, caption };
}

// Build the text typed into the PTY for an uploaded file. Claude reads the
// file from the absolute path with its Read tool.
export function ivUploadAnnotation({ msgtype, savePath, caption }) {
  const kind = msgtype === 'm.image' ? 'an image' : 'a file';
  const annotation = `[The user uploaded ${kind}: ${savePath}]`;
  return caption ? `${caption}\n\n${annotation}` : annotation;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- iv-uploads`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add lib/iv-uploads.js test/iv-uploads.test.js
git commit -m "feat: add iv-mode upload path/annotation helpers"
```

---

## Task 2: Branch `buildMediaContentBlocks` for iv-mode in `index.js`

**Files:**
- Modify: `index.js` (import near the other `./lib/` imports, ~index.js:5-19; branch inside `buildMediaContentBlocks`, index.js:2634-2686)
- Modify: `package.json` (`check` script)

- [ ] **Step 1: Add the import**

Add this line alongside the other `./lib/` imports near the top of `index.js` (e.g. directly after `import { SubagentWatcher } from './lib/subagent-watcher.js';`):

```js
import { ivUploadDir, resolveUploadMeta, ivUploadAnnotation } from './lib/iv-uploads.js';
```

- [ ] **Step 2: Add the iv-mode branch inside `buildMediaContentBlocks`**

The current body (index.js:2645-2678) is an `if (m.audio) … else if (m.image) … else …` chain followed by a caption block. Insert a new `else if (session.iv)` branch between the audio branch and the image branch. The new branch returns early so the SDK-only caption append below does not run.

Find this exact code:

```js
  if (content.msgtype === 'm.audio') {
    const transcription = await transcribeAudio(buffer, mime, { modelPath: WHISPER_MODEL_PATH, language: WHISPER_LANGUAGE });
    blocks.push({ type: 'text', text: `[Voice note transcription]: ${transcription}` });
  } else if (content.msgtype === 'm.image') {
```

Replace it with:

```js
  if (content.msgtype === 'm.audio') {
    const transcription = await transcribeAudio(buffer, mime, { modelPath: WHISPER_MODEL_PATH, language: WHISPER_LANGUAGE });
    blocks.push({ type: 'text', text: `[Voice note transcription]: ${transcription}` });
  } else if (session.iv) {
    // iv-mode: the PTY is text-only. Save the file OUTSIDE the repo and type
    // only an absolute-path annotation; Claude reads it with its Read tool.
    // No base64 blocks and no inline content dump (SDK mode keeps those).
    const { filename, caption } = resolveUploadMeta(content);
    const dir = ivUploadDir(session.roomId);
    const savePath = deduplicateFilename(dir, filename);
    fs.writeFileSync(savePath, buffer);
    blocks.push({ type: 'text', text: ivUploadAnnotation({ msgtype: content.msgtype, savePath, caption }) });
    return blocks; // caption already folded in; skip the SDK caption append below
  } else if (content.msgtype === 'm.image') {
```

(The trailing `} else if (content.msgtype === 'm.image') {` shown above is the existing line — leave the rest of the image/file/caption code unchanged.)

- [ ] **Step 3: Add the new module to the `check` script**

In `package.json`, the `check` script ends with `&& node --check lib/interactive-session.js && node --check test/stub-claude.mjs`. Insert a check for the new module. Change:

```
&& node --check lib/interactive-session.js && node --check test/stub-claude.mjs"
```

to:

```
&& node --check lib/interactive-session.js && node --check lib/iv-uploads.js && node --check test/stub-claude.mjs"
```

- [ ] **Step 4: Verify syntax, lint, and full test suite**

Run: `npm run check && npm run lint && npm test`
Expected: `check` prints nothing/exits 0; `lint` passes with no warnings; all tests pass (existing suite + the new `iv-uploads` tests).

- [ ] **Step 5: Commit**

```bash
git add index.js package.json
git commit -m "feat: save iv-mode uploads outside repo and pass the path to Claude"
```

---

## Self-Review

**Spec coverage:**
- "Make `buildMediaContentBlocks()` mode-aware" → Task 2, Step 2.
- "Save outside the repo at `~/.claude-matrix-uploads/<room>/`" → `ivUploadsRoot`/`ivUploadDir` (Task 1) used in Task 2.
- "Room-id sanitization reusing the `[^A-Za-z0-9_-]→_` pattern" → `sanitizeRoomId` (Task 1).
- "De-duplicate filenames with existing `deduplicateFilename()`" → Task 2, Step 2 calls it.
- "Filename/caption resolution (real filename from `content.filename`)" → `resolveUploadMeta` (Task 1).
- "Pure annotation builder, image vs file, caption first" → `ivUploadAnnotation` (Task 1).
- "Audio stays transcription-only" → audio branch untouched; iv branch sits *after* it (Task 2).
- "SDK mode unchanged" → iv branch returns early; image/file/caption code below is untouched.
- "Testing: annotation builder + upload-dir/sanitization" → Task 1 test file.

**Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands.

**Type consistency:** Helper names are identical across Task 1 (definition), the test file, and Task 2 (import + call sites): `ivUploadDir`, `resolveUploadMeta`, `ivUploadAnnotation`. `resolveUploadMeta` returns `{ filename, caption }`; Task 2 destructures exactly those. `ivUploadAnnotation` takes `{ msgtype, savePath, caption }`; Task 2 passes exactly those. `session.roomId` and `deduplicateFilename(dir, filename)` already exist in `index.js`.
