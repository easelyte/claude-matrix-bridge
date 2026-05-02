import { describe, it, expect, beforeEach } from 'vitest';

beforeEach(() => { process.env.HMAC_SECRET = 'test-secret'; });

describe('viewer token', () => {
  it('round-trips a live-output payload', async () => {
    const { generateSignedUrl, verifyToken } = await import('../viewer/server.js');
    const url = generateSignedUrl('http://x', null, undefined, 60, {
      liveCmdId: 'toolu_1',
      logPath: '/tmp/a.log',
      doneSentinelPath: '/tmp/a.log.done',
    });
    const token = url.split('token=')[1];
    const payload = verifyToken(token);
    expect(payload.liveCmdId).toBe('toolu_1');
    expect(payload.logPath).toBe('/tmp/a.log');
    expect(payload.doneSentinelPath).toBe('/tmp/a.log.done');
    expect(payload.path).toBeUndefined();
  });
});
