import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TranscriptTail } from './transcript-tail.js';

// Subagent transcripts live alongside the parent transcript:
//
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl          (parent)
//   ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/     (one file per subagent)
//       agent-<id>.jsonl
//       agent-<id>.meta.json   { agentType, description }
//
// Discovery is event-triggered: the parent's stream emits a `Task` tool_use
// event the instant a subagent kicks off. The bridge calls
// notifyTaskStarted() at that moment; we poll the subagents directory for a
// brief window (default 5s) until the new agent-<id>.jsonl appears, then
// attach a TranscriptTail. After the window expires we stop polling. Idle
// sessions never poll anything.

function encodeProjectDir(workdir) {
  return workdir.replace(/[/.]/g, '-');
}

export function subagentsDirFor(workdir, sessionId, worktreeName) {
  const encoded = encodeProjectDir(path.resolve(workdir));
  const projectDir = worktreeName
    ? `${encoded}--claude-worktrees-${worktreeName}`
    : encoded;
  return path.join(os.homedir(), '.claude', 'projects', projectDir, sessionId, 'subagents');
}

const DEFAULT_BURST_WINDOW_MS = 5000;
const DEFAULT_BURST_INTERVAL_MS = 200;

export class SubagentWatcher extends EventEmitter {
  constructor({ workdir, sessionId, worktreeName } = {}) {
    super();
    this.dir = subagentsDirFor(workdir, sessionId, worktreeName);
    this.seen = new Set();
    this.tails = new Map(); // filename -> { tail, label, agentId }
    this.burstTimer = null;
    this.snapshotTaken = false;
  }

  // Record any existing agent-*.jsonl files as "seen" so we don't replay
  // subagents from a prior (now-dead) instance of this session. Safe to call
  // even if the dir doesn't exist yet.
  snapshot() {
    if (this.snapshotTaken) return;
    this.snapshotTaken = true;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (name.endsWith('.jsonl')) this.seen.add(name);
      }
    } catch { /* dir doesn't exist yet — fine, will be created when first task fires */ }
  }

  // Called by the bridge when it sees a `Task` tool_use in the parent stream.
  // Briefly polls for new agent-*.jsonl files and attaches a TranscriptTail
  // to each. Multiple Task calls within the same window share a single burst.
  notifyTaskStarted({ windowMs = DEFAULT_BURST_WINDOW_MS, intervalMs = DEFAULT_BURST_INTERVAL_MS } = {}) {
    this.snapshot();
    this._scan();
    this.burstUntil = Date.now() + windowMs;
    if (this.burstTimer) return; // already burst-polling — windowMs is extended
    this.burstTimer = setInterval(() => {
      this._scan();
      if (Date.now() >= this.burstUntil) {
        clearInterval(this.burstTimer);
        this.burstTimer = null;
      }
    }, intervalMs);
    if (typeof this.burstTimer.unref === 'function') this.burstTimer.unref();
  }

  async stop() {
    if (this.burstTimer) {
      clearInterval(this.burstTimer);
      this.burstTimer = null;
    }
    for (const { tail } of this.tails.values()) {
      try { await tail.stop(); } catch { /* ignore */ }
    }
    this.tails.clear();
  }

  _scan() {
    let entries;
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return; // dir doesn't exist yet
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      if (this.seen.has(name)) continue;
      this.seen.add(name);
      this._attach(name);
    }
  }

  _attach(filename) {
    const filePath = path.join(this.dir, filename);
    const agentId = filename.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const metaPath = filePath.replace(/\.jsonl$/, '.meta.json');
    const fallbackLabel = agentId.slice(0, 8);
    const meta = { label: fallbackLabel, agentType: null, fromFile: false };

    const tryReadMeta = () => {
      if (meta.fromFile) return;
      try {
        const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.agentType = parsed.agentType || null;
        if (parsed.description) {
          meta.label = parsed.description.length > 40
            ? parsed.description.slice(0, 37) + '…'
            : parsed.description;
          meta.fromFile = true;
        } else if (parsed.agentType) {
          meta.label = parsed.agentType;
          meta.fromFile = true;
        }
      } catch { /* not yet written — retry on next event */ }
    };

    tryReadMeta();

    const tail = new TranscriptTail(filePath, { readFromStart: true });
    tail.on('event', event => {
      // Retry the meta read on each event until we get a real label —
      // the .meta.json is sometimes written a beat after the .jsonl.
      tryReadMeta();
      this.emit('subagent-event', { agentId, label: meta.label, agentType: meta.agentType, event });
    });
    tail.on('parseError', () => { /* ignore — same policy as parent tail */ });
    tail.start();
    this.tails.set(filename, { tail, label: meta.label, agentId });
    this.emit('subagent-start', { agentId, label: meta.label, agentType: meta.agentType });
  }
}
