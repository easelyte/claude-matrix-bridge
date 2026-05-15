import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import pty from 'node-pty';
import { ensureWorkspaceTrusted } from './pre-trust.js';
import { bracketedPaste, keystroke, SUBMIT_DELAY_MS } from './pty-input.js';
import { TranscriptTail } from './transcript-tail.js';

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

    this.pty.onData(data => this.emit('pty-data', data));
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

  kill(signal = 'SIGTERM') {
    if (this.alive) this.pty.kill(signal);
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
