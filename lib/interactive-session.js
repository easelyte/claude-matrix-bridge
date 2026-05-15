import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import pty from 'node-pty';
import { ensureWorkspaceTrusted } from './pre-trust.js';
import { bracketedPaste, keystroke, SUBMIT_DELAY_MS } from './pty-input.js';
import { TranscriptTail } from './transcript-tail.js';
import { PromptDetector } from './prompt-detector.js';

// Maps an absolute workdir path to claude's transcript directory name.
// claude encodes the path by replacing every `/` with `-`.
function encodeProjectDir(workdir) {
  return workdir.replace(/\//g, '-');
}

export function transcriptPathFor(workdir, sessionId) {
  const encoded = encodeProjectDir(path.resolve(workdir));
  return path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

export class InteractiveSession extends EventEmitter {
  constructor({ roomId, workdir, sessionId, ptyHandle, tail }) {
    super();
    this.roomId = roomId;
    this.workdir = workdir;
    this.sessionId = sessionId;
    this.pty = ptyHandle;
    this.tail = tail;
    this.alive = true;

    this.detector = new PromptDetector();
    this.detector.on('prompt', p => this.emit('prompt', p));
    this.pty.onData(data => {
      this.detector.feed(data);
      this.emit('pty-data', data);
    });
    this.pty.onExit(({ exitCode }) => {
      this.alive = false;
      // Give the tail one more tick to drain anything written just before
      // process exit, then stop it and emit.
      setTimeout(() => {
        this.tail.stop().finally(() => this.emit('exit', exitCode));
      }, 150);
    });
    this.tail.on('event', e => this.emit('event', e));
    this.tail.on('parseError', e => this.emit('parseError', e));
  }

  // Type a user message into the prompt. Uses bracketed paste then a delayed
  // Enter — sending \r immediately after the paste close sequence is silently
  // dropped by claude's TUI (see Phase 0.4 finding in
  // docs/superpowers/plans/2026-05-14-interactive-mode-migration.md).
  sendText(text) {
    if (!this.alive) return false;
    this.pty.write(bracketedPaste(text));
    setTimeout(() => {
      if (this.alive) this.pty.write(keystroke('enter'));
    }, SUBMIT_DELAY_MS);
    return true;
  }

  sendKeystroke(name) {
    if (!this.alive) return false;
    this.pty.write(keystroke(name));
    return true;
  }

  sendRaw(bytes) {
    if (!this.alive) return false;
    this.pty.write(bytes);
    return true;
  }

  // Send a response to a previously-detected interactive prompt. `kind` is
  // the prompt kind from the detector (yes-no, numbered, lettered, arrow-
  // menu); `key` is the option key (or index for arrow menus).
  respondToPrompt({ kind, key }) {
    if (!this.alive) return false;
    if (kind === 'yes-no' || kind === 'numbered' || kind === 'lettered') {
      this.pty.write(keystroke(key));
      setTimeout(() => {
        if (this.alive) this.pty.write(keystroke('enter'));
      }, 50);
      this.detector.reset();
      return true;
    }
    if (kind === 'arrow-menu') {
      const idx = parseInt(key, 10);
      if (!Number.isFinite(idx) || idx < 0) return false;
      // Naive: assume cursor starts at the topmost option. The detector
      // marks options[0] as `selected` so callers should match that. We send
      // `idx` down-arrow keystrokes, then Enter.
      for (let i = 0; i < idx; i++) this.pty.write(keystroke('down'));
      setTimeout(() => {
        if (this.alive) this.pty.write(keystroke('enter'));
      }, 50);
      this.detector.reset();
      return true;
    }
    return false;
  }

  kill(signal = 'SIGTERM') {
    if (this.alive) this.pty.kill(signal);
  }

  // Force-read any transcript content appended since the last poll. Used by
  // the Stop-hook turn-end handler to close the race between the hook firing
  // and the next scheduled tail poll (the assistant event is guaranteed to
  // have been written before the Stop hook ran, but the tail may not have
  // ticked yet).
  drainTranscript() {
    this.tail.drain();
  }
}

export function createInteractiveSession({
  roomId,
  workdir,
  sessionId,
  claudeBin = 'claude',
  claudeArgs = [],
  env = process.env,
  transcriptPath,
  cols = 120,
  rows = 40,
  claudeJsonPath,
}) {
  ensureWorkspaceTrusted(workdir, claudeJsonPath);
  const txPath = transcriptPath || transcriptPathFor(workdir, sessionId);

  const tail = new TranscriptTail(txPath);
  tail.start(); // begin polling before spawn so first events aren't missed

  const ptyHandle = pty.spawn(claudeBin, claudeArgs, {
    name: 'xterm-256color',
    cwd: workdir,
    env: Object.fromEntries(Object.entries(env).filter(([_, v]) => v !== undefined)),
    cols,
    rows,
  });

  return new InteractiveSession({ roomId, workdir, sessionId, ptyHandle, tail });
}
