import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import _fs from 'fs';
import path from 'path';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { mimeForPath, isSensitivePath, resolveInWorkdir, uploadFileToRoom } from '../lib/file-uploader.js';

describe('mimeForPath', () => {
  it('returns correct MIME for known extensions', () => {
    expect(mimeForPath('/foo/bar.js')).toBe('application/javascript');
    expect(mimeForPath('/foo/bar.ts')).toBe('application/typescript');
    expect(mimeForPath('/foo/bar.py')).toBe('text/x-python');
    expect(mimeForPath('/foo/bar.json')).toBe('application/json');
    expect(mimeForPath('/foo/bar.md')).toBe('text/markdown');
    expect(mimeForPath('/foo/bar.png')).toBe('image/png');
  });

  it('returns application/octet-stream for unknown extensions', () => {
    expect(mimeForPath('/foo/bar.xyz')).toBe('application/octet-stream');
    expect(mimeForPath('/foo/bar.custom')).toBe('application/octet-stream');
  });

  it('handles case-insensitive extensions', () => {
    expect(mimeForPath('/foo/bar.JS')).toBe('application/javascript');
    expect(mimeForPath('/foo/bar.JSON')).toBe('application/json');
  });
});

describe('isSensitivePath', () => {
  it('blocks .env files', () => {
    expect(isSensitivePath('/app/.env')).toBe(true);
    expect(isSensitivePath('/app/.env.local')).toBe(true);
    expect(isSensitivePath('/app/.env.production')).toBe(true);
  });

  it('blocks secrets/credentials files', () => {
    expect(isSensitivePath('/app/secrets.json')).toBe(true);
    expect(isSensitivePath('/app/credentials')).toBe(true);
    expect(isSensitivePath('/app/credentials.yaml')).toBe(true);
  });

  it('blocks key files', () => {
    expect(isSensitivePath('/app/server.pem')).toBe(true);
    expect(isSensitivePath('/app/private.key')).toBe(true);
    expect(isSensitivePath('/app/id_rsa')).toBe(true);
    expect(isSensitivePath('/app/id_ed25519')).toBe(true);
  });

  it('blocks sensitive directories', () => {
    expect(isSensitivePath('/home/user/.aws/config')).toBe(true);
    expect(isSensitivePath('/home/user/.ssh/known_hosts')).toBe(true);
    expect(isSensitivePath('/home/user/.docker/config.json')).toBe(true);
    expect(isSensitivePath('/home/user/.kube/config')).toBe(true);
    expect(isSensitivePath('/home/user/.gnupg/secring.gpg')).toBe(true);
  });

  it('allows normal code files', () => {
    expect(isSensitivePath('/app/src/index.js')).toBe(false);
    expect(isSensitivePath('/app/README.md')).toBe(false);
    expect(isSensitivePath('/app/package.json')).toBe(false);
  });
});

describe('resolveInWorkdir', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'file-upload-test-'));
    writeFileSync(path.join(tmpDir, 'inside.txt'), 'hello');
    writeFileSync('/tmp/outside-target.txt', 'secret');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    try { rmSync('/tmp/outside-target.txt'); } catch {}
  });

  it('returns resolved path for file inside workdir', async () => {
    const result = await resolveInWorkdir(path.join(tmpDir, 'inside.txt'), tmpDir);
    expect(result).toBe(path.join(tmpDir, 'inside.txt'));
  });

  it('returns null for file outside workdir', async () => {
    const result = await resolveInWorkdir('/etc/passwd', tmpDir);
    expect(result).toBeNull();
  });

  it('returns null for symlink pointing outside workdir', async () => {
    const linkPath = path.join(tmpDir, 'sneaky-link');
    symlinkSync('/tmp/outside-target.txt', linkPath);
    const result = await resolveInWorkdir(linkPath, tmpDir);
    expect(result).toBeNull();
  });

  it('handles workdir with trailing slash', async () => {
    const result = await resolveInWorkdir(path.join(tmpDir, 'inside.txt'), tmpDir + '/');
    expect(result).toBe(path.join(tmpDir, 'inside.txt'));
  });

  it('rejects prefix-collision paths', async () => {
    // /tmp/file-upload-test-ABC should not match /tmp/file-upload-test-ABCDEF
    const result = await resolveInWorkdir(tmpDir + 'extra/evil.txt', tmpDir);
    expect(result).toBeNull();
  });

  it('falls back to lexical check for non-existent files', async () => {
    const result = await resolveInWorkdir(path.join(tmpDir, 'does-not-exist.txt'), tmpDir);
    expect(result).toBe(path.join(tmpDir, 'does-not-exist.txt'));
  });
});

describe('uploadFileToRoom', () => {
  let tmpDir;
  let mockClient;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'file-upload-test-'));
    mockClient = {
      crypto: {
        encryptMedia: vi.fn(async (_buf) => ({
          buffer: Buffer.from('encrypted'),
          file: { key: { kty: 'oct', key_ops: ['encrypt', 'decrypt'], alg: 'A256CTR', k: 'testkey', ext: true }, iv: 'testiv', hashes: { sha256: 'testhash' }, v: 'v2' },
        })),
      },
      uploadContent: vi.fn(async () => 'mxc://example.com/abc123'),
      sendMessage: vi.fn(async () => '$event123'),
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uploads a file successfully', async () => {
    writeFileSync(path.join(tmpDir, 'test.js'), 'console.log("hello");');
    const result = await uploadFileToRoom(mockClient, '!room:s', path.join(tmpDir, 'test.js'), {
      workdir: tmpDir,
      toolUseId: 'toolu_test1',
    });
    expect(result).toBe('$event123');
    expect(mockClient.uploadContent).toHaveBeenCalled();
    expect(mockClient.sendMessage).toHaveBeenCalledWith('!room:s', expect.objectContaining({
      msgtype: 'm.file',
      filename: 'test.js',
      info: expect.objectContaining({ mimetype: 'application/javascript' }),
    }));
  });

  it('skips files exceeding maxBytes', async () => {
    writeFileSync(path.join(tmpDir, 'big.txt'), 'x'.repeat(100));
    const result = await uploadFileToRoom(mockClient, '!room:s', path.join(tmpDir, 'big.txt'), {
      workdir: tmpDir,
      maxBytes: 50,
      toolUseId: 'toolu_big',
    });
    expect(result).toBeNull();
    expect(mockClient.uploadContent).not.toHaveBeenCalled();
  });

  it('skips missing files', async () => {
    const result = await uploadFileToRoom(mockClient, '!room:s', path.join(tmpDir, 'nope.txt'), {
      workdir: tmpDir,
      toolUseId: 'toolu_missing',
    });
    expect(result).toBeNull();
    expect(mockClient.uploadContent).not.toHaveBeenCalled();
  });

  it('returns null and logs on upload error', async () => {
    writeFileSync(path.join(tmpDir, 'fail.txt'), 'data');
    mockClient.uploadContent.mockRejectedValueOnce(new Error('413 Too Large'));
    const result = await uploadFileToRoom(mockClient, '!room:s', path.join(tmpDir, 'fail.txt'), {
      workdir: tmpDir,
      toolUseId: 'toolu_fail',
    });
    expect(result).toBeNull();
  });

  it('encrypts when encrypt option is true', async () => {
    writeFileSync(path.join(tmpDir, 'encrypted-test.txt'), 'data');
    const result = await uploadFileToRoom(mockClient, '!room:s', path.join(tmpDir, 'encrypted-test.txt'), {
      workdir: tmpDir,
      encrypt: true,
      toolUseId: 'toolu_enc',
    });
    expect(result).toBe('$event123');
    expect(mockClient.crypto.encryptMedia).toHaveBeenCalled();
    expect(mockClient.sendMessage).toHaveBeenCalledWith('!room:s', expect.objectContaining({
      file: expect.objectContaining({ url: 'mxc://example.com/abc123' }),
    }));
  });

  it('denies files outside workdir', async () => {
    const result = await uploadFileToRoom(mockClient, '!room:s', '/etc/passwd', {
      workdir: tmpDir,
      toolUseId: 'toolu_outside',
    });
    expect(result).toBeNull();
    expect(mockClient.uploadContent).not.toHaveBeenCalled();
  });

  it('denies sensitive files', async () => {
    writeFileSync(path.join(tmpDir, '.env.local'), 'SECRET=foo');
    const result = await uploadFileToRoom(mockClient, '!room:s', path.join(tmpDir, '.env.local'), {
      workdir: tmpDir,
      toolUseId: 'toolu_sensitive',
    });
    expect(result).toBeNull();
    expect(mockClient.uploadContent).not.toHaveBeenCalled();
  });
});

describe('concurrency semaphore', () => {
  let tmpDir;
  let mockClient;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'file-upload-conc-'));
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(tmpDir, `file${i}.txt`), `content${i}`);
    }
    let resolvers = [];
    mockClient = {
      crypto: { encryptMedia: vi.fn() },
      uploadContent: vi.fn(() => new Promise(resolve => {
        resolvers.push(() => resolve('mxc://test/123'));
      })),
      sendMessage: vi.fn(async () => '$ev'),
      _resolvers: resolvers,
      _resolveAll: () => { while (resolvers.length) resolvers.shift()(); },
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('limits concurrent uploads to 3', async () => {
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(uploadFileToRoom(mockClient, '!room:s', path.join(tmpDir, `file${i}.txt`), {
        workdir: tmpDir,
        toolUseId: `toolu_${i}`,
      }));
    }
    // Wait a tick for the first 3 to start
    await new Promise(r => setTimeout(r, 50));
    // Should have exactly 3 pending uploadContent calls
    expect(mockClient.uploadContent).toHaveBeenCalledTimes(3);

    // Resolve all pending uploads
    mockClient._resolveAll();
    await new Promise(r => setTimeout(r, 50));
    mockClient._resolveAll();
    await Promise.all(promises);
    expect(mockClient.uploadContent).toHaveBeenCalledTimes(5);
  });
});
