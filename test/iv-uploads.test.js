import { describe, it, expect } from 'vitest';
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

  it('strips directory components from the filename (no path traversal)', () => {
    expect(resolveUploadMeta({ body: '../../etc/passwd' })).toEqual({
      filename: 'passwd',
      caption: null,
    });
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
