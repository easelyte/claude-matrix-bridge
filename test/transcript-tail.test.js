import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TranscriptTail } from '../lib/transcript-tail.js';

// Helper: wait until `cond()` returns truthy, polling at `interval`ms,
// failing after `timeout`ms. chokidar's debounce + filesystem events
// make polling more reliable than fixed sleeps.
async function waitFor(cond, { timeout = 2000, interval = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, interval));
  }
}

describe('TranscriptTail', () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
    file = path.join(dir, 'session.jsonl');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('emits events that are appended after start, in order', async () => {
    const tail = new TranscriptTail(file);
    const events = [];
    tail.on('event', e => events.push(e));
    await tail.start();
    fs.writeFileSync(file, JSON.stringify({ type: 'user', n: 1 }) + '\n');
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', n: 2 }) + '\n');
    fs.appendFileSync(file, JSON.stringify({ type: 'result', n: 3 }) + '\n');
    await waitFor(() => events.length >= 3);
    await tail.stop();
    expect(events.map(e => e.n)).toEqual([1, 2, 3]);
  });

  it('handles a line split across two writes', async () => {
    const tail = new TranscriptTail(file);
    const events = [];
    tail.on('event', e => events.push(e));
    await tail.start();
    fs.writeFileSync(file, '{"type":"u","n":1}\n{"type":"u","n":');
    await waitFor(() => events.length >= 1);
    fs.appendFileSync(file, '2}\n');
    await waitFor(() => events.length >= 2);
    await tail.stop();
    expect(events.map(e => e.n)).toEqual([1, 2]);
  });

  it('emits a complete final line with no trailing newline yet, without double-emitting', async () => {
    // Reproduces the ask_user-before-block case: claude writes a tool-call
    // record then blocks for the answer, so the line's terminating newline
    // isn't flushed until the next record (after the answer). The tail must
    // emit the complete object immediately, and must not re-emit it when the
    // newline + next record finally arrive.
    const tail = new TranscriptTail(file);
    const events = [];
    tail.on('event', e => events.push(e));
    await tail.start();
    fs.writeFileSync(file, '{"type":"assistant","tool":"ask_user","n":1}');
    await waitFor(() => events.length >= 1);
    expect(events[0]).toMatchObject({ tool: 'ask_user', n: 1 });
    fs.appendFileSync(file, '\n{"type":"user","n":2}\n');
    await waitFor(() => events.length >= 2);
    await tail.stop();
    expect(events.map(e => e.n)).toEqual([1, 2]);
  });

  it('emits parseError on a malformed line and keeps tailing', async () => {
    const tail = new TranscriptTail(file);
    const events = [];
    const errors = [];
    tail.on('event', e => events.push(e));
    tail.on('parseError', e => errors.push(e));
    await tail.start();
    fs.writeFileSync(file, 'not json\n{"type":"a"}\n');
    await waitFor(() => events.length >= 1 && errors.length >= 1);
    await tail.stop();
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe('not json');
    expect(events).toHaveLength(1);
  });

  it('starts tailing a file that does not exist yet (created after start)', async () => {
    const tail = new TranscriptTail(file);
    const events = [];
    tail.on('event', e => events.push(e));
    await tail.start();
    // File doesn't exist at start; create it after a tick.
    await new Promise(r => setTimeout(r, 50));
    fs.writeFileSync(file, JSON.stringify({ type: 'user', n: 1 }) + '\n');
    await waitFor(() => events.length >= 1);
    await tail.stop();
    expect(events.map(e => e.n)).toEqual([1]);
  });

  it('resets when the file is truncated (offset > new size)', async () => {
    const tail = new TranscriptTail(file);
    const events = [];
    tail.on('event', e => events.push(e));
    await tail.start();
    fs.writeFileSync(file, JSON.stringify({ type: 'a', n: 1, padding: 'xxxxxxxxxx' }) + '\n');
    await waitFor(() => events.length >= 1);
    // Truncate to a shorter file; new content must be emitted.
    fs.writeFileSync(file, JSON.stringify({ type: 'a', n: 2 }) + '\n');
    await waitFor(() => events.length >= 2);
    await tail.stop();
    expect(events.map(e => e.n)).toEqual([1, 2]);
  });

  it('reads pre-existing content on start when readFromStart is true', async () => {
    fs.writeFileSync(file, JSON.stringify({ type: 'a', n: 1 }) + '\n' + JSON.stringify({ type: 'b', n: 2 }) + '\n');
    const tail = new TranscriptTail(file, { readFromStart: true });
    const events = [];
    tail.on('event', e => events.push(e));
    await tail.start();
    await waitFor(() => events.length >= 2);
    await tail.stop();
    expect(events.map(e => e.n)).toEqual([1, 2]);
  });
});
