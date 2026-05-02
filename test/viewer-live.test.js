import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';

let server, port;
beforeAll(async () => {
  process.env.HMAC_SECRET = 'test-secret';
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0); // 0 = ephemeral port
  await new Promise(r => server.on('listening', r));
  port = server.address().port;
});
afterAll(() => server?.close());

describe('GET /live', () => {
  it('rejects missing token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/live`);
    expect(res.status).toBe(400);
  });

  it('rejects expired token', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, null, undefined, -10, {
      liveCmdId: 'x', logPath: '/tmp/x.log', doneSentinelPath: '/tmp/x.log.done',
    }).replace('/view', '/live');
    const res = await fetch(url);
    expect(res.status).toBe(403);
  });

  it('serves HTML for valid live token', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, null, undefined, 60, {
      liveCmdId: 'x', logPath: '/tmp/x.log', doneSentinelPath: '/tmp/x.log.done',
    }).replace('/view', '/live');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/html/);
    const body = await res.text();
    expect(body).toContain('<pre');
    expect(body).toContain('/live/ws');
  });

  it('serves the matron-live-output plugin bundle from /plugin/live-output.mjs', async () => {
    // Skip if the bundle doesn't exist locally — the build is in a sibling
    // repo (matron-web) and we don't want to fail this test for missing
    // build artifacts.
    const fs = await import('node:fs');
    const bundlePath = process.env.MATRON_PLUGIN_DIR
      ? `${process.env.MATRON_PLUGIN_DIR}/live-output.mjs`
      : path.join(process.cwd(), 'plugins', 'live-output.mjs');
    if (!fs.existsSync(bundlePath)) {
      console.log('skip: plugin bundle not present at', bundlePath);
      return;
    }
    const res = await fetch(`http://127.0.0.1:${port}/plugin/live-output.mjs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(100);
  });
});
