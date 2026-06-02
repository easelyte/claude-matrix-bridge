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
  // Cap at 80 (vs. 50 for PTY-dump logs in interactive-session.js): these paths
  // aren't correlated, and upload dirs can use a bit more room-name headroom.
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
  // path.basename strips any directory components a malicious/odd Matrix
  // filename might contain (e.g. "../../etc/passwd"), so uploads can't escape
  // the per-room upload dir. The `|| 'file'` guards names that basename to ''.
  const filename = path.basename(content.filename || content.body || 'file') || 'file';
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
