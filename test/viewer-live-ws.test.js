import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import WebSocket from 'ws';

let server, port;
beforeAll(async () => {
  process.env.HMAC_SECRET = 'test-secret';
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0);
  await new Promise(r => server.on('listening', r));
  port = server.address().port;
});
afterAll(() => server?.close());

describe('GET /live/ws', () => {
  it('streams log content and closes on .done sentinel', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'ws-'));
    const logPath = path.join(tmp, 'cmd.log');
    writeFileSync(logPath, 'line1\nline2\n');

    const { generateSignedUrl } = await import('../viewer/server.js');
    const url = generateSignedUrl(`ws://127.0.0.1:${port}`, null, undefined, 60, {
      liveCmdId: 'test1', logPath, doneSentinelPath: `${logPath}.done`,
    }).replace('/view?', '/live/ws?');

    const messages = [];
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on('message', m => messages.push(JSON.parse(m.toString())));
      ws.on('open', () => {
        setTimeout(() => {
          appendFileSync(logPath, 'line3\n');
          setTimeout(() => {
            writeFileSync(`${logPath}.done`, JSON.stringify({ exitCode: 0, denied: false, truncated: false }));
          }, 50);
        }, 50);
      });
      ws.on('close', resolve);
      ws.on('error', reject);
    });

    const concat = messages.filter(m => m.type === 'data').map(m => m.chunk).join('');
    expect(concat).toContain('line1');
    expect(concat).toContain('line2');
    expect(concat).toContain('line3');
    const complete = messages.find(m => m.type === 'complete');
    expect(complete).toEqual({ type: 'complete', exitCode: 0, denied: false, truncated: false });

    rmSync(tmp, { recursive: true });
  });

  it('does not drop tail data when sentinel arrives immediately after last write', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'ws-race-'));
    const logPath = path.join(tmp, 'cmd.log');

    const { generateSignedUrl } = await import('../viewer/server.js');
    const url = generateSignedUrl(`ws://127.0.0.1:${port}`, null, undefined, 60, {
      liveCmdId: 'race1', logPath, doneSentinelPath: `${logPath}.done`,
    }).replace('/view?', '/live/ws?');

    const messages = [];
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on('message', m => messages.push(JSON.parse(m.toString())));
      ws.on('open', () => {
        // Write log content and sentinel synchronously without an intervening tick.
        // This is the worst-case race for the WS handler.
        writeFileSync(logPath, 'first\nsecond\nthird\n');
        writeFileSync(`${logPath}.done`, JSON.stringify({ exitCode: 0, denied: false, truncated: false }));
      });
      ws.on('close', resolve);
      ws.on('error', reject);
    });

    const concat = messages.filter(m => m.type === 'data').map(m => m.chunk).join('');
    expect(concat).toContain('first');
    expect(concat).toContain('second');
    expect(concat).toContain('third');
    const complete = messages.find(m => m.type === 'complete');
    expect(complete).toBeDefined();
    rmSync(tmp, { recursive: true });
  });
});
