import { EventEmitter } from 'node:events';
import fs from 'node:fs';

// Tails a JSONL file emitted by `claude` (the on-disk session transcript at
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl). Emits one `event` per
// parsed line and `parseError` for malformed lines (which are not fatal).
//
// Uses periodic stat polling rather than fs.watch / chokidar. The transcript
// is small (a few hundred KB max during a long session) and chokidar v4 has
// proven unreliable here — rapid appends to a not-yet-existent file are
// silently missed. Polling at 100ms is plenty for human-perceptible latency
// and uses negligible CPU.
//
// By default the tail starts from end-of-file: only lines appended after
// start() are emitted. Pass { readFromStart: true } to also replay anything
// already in the file — useful for resuming a session whose transcript file
// already exists.

const DEFAULT_INTERVAL_MS = 100;

export class TranscriptTail extends EventEmitter {
  constructor(filePath, { readFromStart = false, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    super();
    this.filePath = filePath;
    this.readFromStart = readFromStart;
    this.intervalMs = intervalMs;
    this.offset = 0;
    this.lineBuf = '';
    this.timer = null;
    this.started = false;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    if (this.readFromStart) {
      this.offset = 0;
    } else if (fs.existsSync(this.filePath)) {
      this.offset = fs.statSync(this.filePath).size;
    }
    // Tick once immediately so existing readFromStart content is picked up
    // before start() resolves.
    this._tick();
    this.timer = setInterval(() => this._tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Synchronously read any content that has been appended since the last
  // tick and emit events. Use this when a downstream signal (e.g. a Stop
  // hook firing via HTTP) tells us a turn is complete and we want to be
  // sure all transcript events for that turn have been processed before
  // running end-of-turn logic.
  drain() {
    this._tick();
  }

  _tick() {
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch (_) {
      return; // file doesn't exist yet
    }
    if (stat.size < this.offset) {
      // Truncation or replacement — restart from the top.
      this.offset = 0;
      this.lineBuf = '';
    }
    if (stat.size === this.offset) return;
    const len = stat.size - this.offset;
    const fd = fs.openSync(this.filePath, 'r');
    const buf = Buffer.alloc(len);
    try {
      fs.readSync(fd, buf, 0, len, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset = stat.size;
    this.lineBuf += buf.toString('utf8');
    const lines = this.lineBuf.split('\n');
    this.lineBuf = lines.pop(); // last fragment is incomplete (or empty)
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        this.emit('event', JSON.parse(line));
      } catch (error) {
        this.emit('parseError', { line, error });
      }
    }
  }
}
