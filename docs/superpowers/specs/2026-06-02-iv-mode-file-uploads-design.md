# Interactive-mode file uploads — design

**Date:** 2026-06-02
**Status:** Approved (pending spec review)

## Problem

The Matrix bridge supports uploads in SDK (print) mode, where
`buildMediaContentBlocks()` downloads an attachment, saves it into the session
workdir, and returns rich Anthropic content blocks (base64 image / PDF /
document) that the API consumes directly.

In **interactive (iv) mode** there is no real upload support. The PTY input
channel is text-only, so `sendToSession()` (index.js:1891) keeps only the
`text` blocks and drops the rich ones. Today this means uploads "work" only by
accident — the SDK-oriented `"Image saved to <path>"` / `"File saved to
<path>"` text blocks leak through and get typed into the prompt. Side effects:

- Text/JSON/CSV uploads dump the **entire file contents** inline into the PTY
  paste (unbounded, noisy).
- Files land in the **workdir root**, cluttering the project (a git repo).
- The framing is terse and SDK-shaped, not a deliberate "the user uploaded a
  file" message.

The code's own comment (index.js:1893) flags real iv-mode media handling as a
deferred "Phase 6". This design implements it.

## Goal

In iv-mode, when the user uploads a file: download + decrypt it, save it to a
location **outside the repo**, and type a short annotation into the PTY telling
Claude the absolute path. Claude reads the file from that path with its `Read`
tool. No base64, no inline content dumps.

## Approach

Make `buildMediaContentBlocks()` **mode-aware**. This one function already
feeds both the live-send path (index.js:3781) and the queue path
(index.js:3721), so branching here keeps the queue, flush, typing-indicator,
and room-naming logic untouched.

### Behavior matrix

| msgtype     | iv-mode (new)                                              | SDK mode (unchanged) |
|-------------|-----------------------------------------------------------|----------------------|
| `m.image`   | save to uploads dir; return one text block annotating the path | save to workdir; image base64 block |
| `m.file`    | save to uploads dir; return one text block annotating the path | save to workdir; PDF/image/text/binary block |
| `m.audio`   | transcribe; return transcription text block (no saved file) | transcribe; transcription text block |

In iv-mode, **no** base64 image/document blocks are produced, and the text-file
content dump is **not** performed — only a path annotation is returned.

### Components

1. **Mode branch in `buildMediaContentBlocks()` (index.js:2634).**
   At the top, if `session.iv` is set, route image/file handling through the
   new iv path below. Audio is shared (transcription is identical in both
   modes). The non-iv code path is left exactly as-is.

2. **Upload-dir helper.**
   `ivUploadDir(roomId)` → `~/.claude-matrix-uploads/<sanitized-room>/`,
   created on demand (`fs.mkdirSync(..., { recursive: true })`). Room id
   sanitized with the existing `[^A-Za-z0-9_-] → _` pattern already used at
   interactive-session.js:39 (slice to a safe length). Filenames de-duplicated
   with the existing `deduplicateFilename()`.

3. **Filename / caption resolution.**
   Matrix sends the real filename and an optional caption in two fields. When a
   caption is attached, `content.filename` holds the real filename and
   `content.body` holds the caption; with no caption, `content.body` is the
   filename and `content.filename` is absent. Resolve as:
   - filename = `content.filename || content.body || 'file'`
   - caption  = (`content.filename && content.body && content.body !== content.filename`)
     ? `content.body` : `null`

   (The existing SDK path saves under `content.body` and has a latent
   wrong-filename bug for captioned uploads; the iv path does this correctly and
   leaves the SDK path untouched.)

4. **Pure annotation builder (testable).**
   `ivUploadAnnotation({ msgtype, savePath, caption })` → string.
   - image → `[The user uploaded an image: <savePath>]`
   - file  → `[The user uploaded a file: <savePath>]`
   - If `caption` is non-null, it becomes the primary line and the annotation is
     appended: `<caption>\n\n[The user uploaded an image: <savePath>]`.
   No filesystem or network access — unit-testable in isolation.

### Data flow (iv-mode)

```
Matrix m.image/m.file event
  → room.message handler (hasMedia branch, index.js:3772 / queue at 3719)
  → buildMediaContentBlocks(event, session)        [session.iv set]
      → downloadMatrixFile(mxc, content.file)       (reused)
      → save to ivUploadDir(roomId)/<dedup name>
      → return [{ type: 'text', text: ivUploadAnnotation(...) }]
  → sendToSession iv-branch (index.js:1891)
      → joins text blocks → session.iv.sendText()   → bracketed paste + Enter
```

Because the returned block list is text-only, `sendToSession`'s
"can't send N non-text attachment(s)" warning path never fires, and the queue /
`flushQueue` text-join logic works unchanged.

## Error handling

Download/decrypt failures continue to surface through the existing `try/catch`
in the `room.message` handler (`"Failed to process file: <err>"`,
index.js:3725 / 3809). No new error surface.

## Testing

- `ivUploadAnnotation()` — unit tests: image vs file; with caption vs without.
- `ivUploadDir()` — unit test: room-id sanitization and path shape (no real
  mkdir assertion needed beyond the returned path; can point `HOME` at a tmp
  dir if exercising creation).
- Optionally, a `buildMediaContentBlocks` test with a fake `session.iv` and a
  stubbed `downloadMatrixFile` asserting it writes a file outside the workdir
  and returns a single text-only block. Depth decided in the plan.

## Out of scope

- SDK (print) mode behavior — unchanged.
- Pushing real image bytes through the PTY — not possible; path reference is the
  mechanism.
- Retention / cleanup of `~/.claude-matrix-uploads/` — possible follow-up.
