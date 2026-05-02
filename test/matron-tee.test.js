import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const run = promisify(execFile);
const TEE = path.resolve('hooks/matron-tee');

describe('matron-tee', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'tee-test-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('captures stdout and stderr to log file', async () => {
    const log = path.join(tmp, 'out.log');
    await run(TEE, [log, '--', 'sh', '-c', 'echo hi-stdout; echo hi-stderr 1>&2']);
    const content = readFileSync(log, 'utf-8');
    expect(content).toContain('hi-stdout');
    expect(content).toContain('hi-stderr');
  });

  it('preserves stderr channel separation', async () => {
    const log = path.join(tmp, 'out.log');
    const child = spawn(TEE, [log, '--', 'sh', '-c', 'echo hi-stdout; echo hi-stderr 1>&2']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });
    await new Promise((resolve, reject) => {
      child.on('close', resolve);
      child.on('error', reject);
    });
    expect(stdout).toContain('hi-stdout');
    expect(stdout).not.toContain('hi-stderr');
    expect(stderr).toContain('hi-stderr');
    expect(stderr).not.toContain('hi-stdout');
  });

  it('propagates non-zero exit code', async () => {
    const log = path.join(tmp, 'out.log');
    await expect(run(TEE, [log, '--', 'sh', '-c', 'exit 7']))
      .rejects.toMatchObject({ code: 7 });
  });

  it('propagates zero exit code', async () => {
    const log = path.join(tmp, 'out.log');
    const { stdout } = await run(TEE, [log, '--', 'sh', '-c', 'exit 0']);
    expect(stdout).toBe('');
  });

  it('truncates output past MATRON_LIVE_OUTPUT_MAX_BYTES', async () => {
    const log = path.join(tmp, 'out.log');
    // Cap at 1KB; produce 5KB of output
    await run(TEE, [log, '--', 'sh', '-c', 'yes x | head -c 5000'], {
      env: { ...process.env, MATRON_LIVE_OUTPUT_MAX_BYTES: '1024' }
    });
    const content = readFileSync(log, 'utf-8');
    expect(content).toContain('[matron-tee: output truncated at 1024 bytes]');
    const sentinelIdx = content.indexOf('[matron-tee: output truncated');
    // Sentinel is preceded by at most MAX_BYTES of payload plus a single delimiting '\n'.
    expect(sentinelIdx).toBeLessThanOrEqual(1025);
  });
});
