import dotenv from 'dotenv';
dotenv.config({ override: true });
import { MatrixClient, SimpleFsStorageProvider, AutojoinRoomsMixin, RustSdkCryptoStorageProvider } from 'matrix-bot-sdk';
import { spawn, execFileSync } from 'child_process';
import { transcribeAudio } from './lib/transcribe.js';
import { createServer } from 'http';
import { createHmac, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import os from 'os';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createLiveOutputStore, sweepOrphanedLogs } from './lib/live-output.js';
import { generateSignedUrl } from './lib/viewer-tokens.js';
import { createInteractiveSession } from './lib/interactive-session.js';
import { extractUrls, isIdleReadyScreen } from './lib/prompt-detector.js';
import { buildMcpServers, extractMcpExtraFlags, extractWorktreeFlag, extractPromptFlag, knownMcpExtras } from './lib/mcp-config.js';
import { SubagentWatcher } from './lib/subagent-watcher.js';
import { ivUploadDir, resolveUploadMeta, ivUploadAnnotation } from './lib/iv-uploads.js';

const DEFAULT_BRIDGE_CLAUDE_MD_PATH = path.join(__dirname, 'BRIDGE_CLAUDE.md');
const FALLBACK_BRIDGE_PROMPT = 'When you need to ask the user a question, use the mcp__ask-user__ask_user tool instead of AskUserQuestion. AskUserQuestion is not available in this environment.';

// --- Config ---

const MATRIX_HOMESERVER_URL = process.env.MATRIX_HOMESERVER_URL || 'http://localhost:6167';
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;

const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

const DEFAULT_WORKDIR = path.resolve(expandHome(process.env.DEFAULT_WORKDIR || process.cwd()));
// Idle reaping: a session is killed if no activity (incoming user message OR
// outgoing assistant text posted to Matrix) is observed within this window.
// Sessions are resumable, so the next user message will respawn claude with
// --resume. Set to 0 to disable.
// Default 1h. Reaping is silent and the next user message auto-resumes the
// session via the existing path, so the only cost is a few-second resume on
// re-entry — well worth it on memory-constrained hosts where idle sessions
// previously piled up for a full day (~1G each with default extras). Override
// via SESSION_IDLE_TIMEOUT_MS (set to 86400000 to restore the old 24h
// behaviour, or 0 to disable the reaper entirely).
const SESSION_IDLE_TIMEOUT_MS = parseInt(process.env.SESSION_IDLE_TIMEOUT_MS || '3600000', 10);
const SESSION_IDLE_CHECK_MS = parseInt(process.env.SESSION_IDLE_CHECK_MS || '300000', 10);

// Resume-readiness gate (iv-mode). A freshly-spawned `claude --resume` takes
// several seconds to load the transcript — and longer if it auto-compacts —
// far longer than the 500ms paste→Enter window in sendText. Typing the first
// message in immediately drops it (the paste lands in a not-ready input box and
// the Enter is swallowed). So we HOLD post-resume messages and only flush them
// once the TUI goes idle-and-ready: PTY output quiesces for QUIET_MS AND the
// screen shows the idle input box (no "esc to interrupt"). HARDCAP_MS is the
// backstop so a message is never lost if readiness is never detected.
const RESUME_READY_QUIET_MS = parseInt(process.env.RESUME_READY_QUIET_MS || '800', 10);
const RESUME_READY_HARDCAP_MS = parseInt(process.env.RESUME_READY_HARDCAP_MS || '120000', 10);
const MAX_MSG_LENGTH = 32768;  // Matrix supports ~65KB, use 32K as practical limit
const DEBUG = process.env.DEBUG === '1';
const ENCRYPT_SESSION_ROOMS = process.env.ENCRYPT_SESSION_ROOMS !== '0';
function encodeProjectDir(p) { return p.replace(/[/.]/g, '-'); }
const MATRIX_EVENT_NAMESPACE = 'chat.matron';
const INTERACTIVE_MODE = process.env.MATRON_INTERACTIVE_MODE === '1';
const COMMAND_EVENT_TYPES = [`${MATRIX_EVENT_NAMESPACE}.commands`];
const SESSIONS_FILE = path.join(os.homedir(), '.claude-matrix-sessions.json');
const ROLES_FILE = path.join(os.homedir(), '.claude-matrix-roles.json');

// --- Role management ---

const roles = new Map();

function loadRoles() {
  try {
    if (fs.existsSync(ROLES_FILE)) {
      const data = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf-8'));
      for (const [userId, role] of Object.entries(data)) {
        if (role === 'admin' || role === 'member') roles.set(userId, role);
      }
    }
  } catch (e) {
    console.error('Failed to load roles file:', e.message);
  }
  if (ALLOWED_USER_IDS.length > 0 && !Array.from(roles.values()).includes('admin')) {
    roles.set(ALLOWED_USER_IDS[0], 'admin');
  }
}

function saveRoles() {
  const tmp = ROLES_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(roles), null, 2));
    fs.renameSync(tmp, ROLES_FILE);
    return true;
  } catch (e) {
    console.error('Failed to save roles file:', e.message);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return false;
  }
}

function getUserRole(userId) {
  return roles.get(userId) || 'member';
}

loadRoles();

// Generate MCP config with resolved paths (--mcp-config requires a file, not inline JSON).
// The on-disk baseline assumes Linux (xvfb-run wraps the browser MCP); on macOS we
// strip that wrapper before writing the generated file so the server actually starts
// instead of failing with `spawn xvfb-run ENOENT`.
//
// mcp-config.json has two sections:
//   `mcpServers` — always-on (ask-user) — every session gets these
//   `mcpExtras`  — opt-in groups keyed by name (e.g. `browser`) — selected per
//                  session via flags on /start, /resume, /workdir
// Per opt-in combination we write a separate generated file (`.mcp-config-
// generated[.<extras>].json`) and pass its path to claude. Each browser stack
// is ~400M resident, so defaulting to none keeps lightweight sessions lean.
const RAW_MCP_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'mcp-config.json'), 'utf-8'));
const mcpConfigPathCache = new Map(); // sorted-extras-key -> generated file path

function mcpConfigPathFor(extras = []) {
  const { config, extras: sorted } = buildMcpServers({
    baseConfig: RAW_MCP_CONFIG,
    extras,
    askUserBaseDir: __dirname,
  });
  const key = sorted.join(',');
  const cached = mcpConfigPathCache.get(key);
  if (cached) return cached;
  const suffix = sorted.length ? '.' + sorted.join('-') : '';
  const p = path.join(__dirname, `.mcp-config-generated${suffix}.json`);
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
  mcpConfigPathCache.set(key, p);
  return p;
}

// Eagerly materialise the default (no-extras) config so the file exists on
// disk by the time any session spawns. Per-extras variants are generated
// lazily on first use.
mcpConfigPathFor([]);
// Sanity check: make sure the bridge's known extras stay in sync with what
// the config file declares.
for (const ex of knownMcpExtras()) {
  if (!RAW_MCP_CONFIG.mcpExtras?.[ex]) {
    console.warn(`[mcp-config] Flag --${ex} is recognised but no matching mcpExtras block exists; sessions opting in will get no extra servers.`);
  }
}
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH || path.join(os.homedir(), '.local/share/whisper-cpp/models/ggml-small.bin');
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || 'en';

// Server label for room names: "dev-3" → "3", fallback to SERVER_LABEL env var
let SERVER_LABEL = process.env.SERVER_LABEL || (() => {
  const hostname = os.hostname();
  const match = hostname.match(/^(\w+)-(\d+)/);
  if (match) return match[2]; // Just the number
  return hostname.slice(0, 4).toUpperCase();
})();
const HMAC_SECRET = process.env.HMAC_SECRET || '';
const VIEWER_BASE_URL = process.env.VIEWER_BASE_URL || '';
const LINK_EXPIRY_MS = parseInt(process.env.LINK_EXPIRY_MS || String(15 * 60 * 1000), 10);
const SECRETS_DIR = path.join(os.homedir(), '.secrets');
const SECRET_TTL_MS = 3600000; // 1 hour
const BRIDGE_CLAUDE_MD_PATH = process.env.BRIDGE_CLAUDE_MD_PATH || DEFAULT_BRIDGE_CLAUDE_MD_PATH;

// Gemini client for room topic summarization
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

function loadBridgeSystemPrompt() {
  try {
    return fs.readFileSync(BRIDGE_CLAUDE_MD_PATH, 'utf-8').trim();
  } catch (e) {
    console.warn(`Could not read bridge Claude instructions from ${BRIDGE_CLAUDE_MD_PATH}: ${e.message}`);
    return FALLBACK_BRIDGE_PROMPT;
  }
}

const BRIDGE_SYSTEM_PROMPT = loadBridgeSystemPrompt();

// Live-bash-output store (per-process). Tracks active matron-tee'd Bash commands
// so that tool_result events can write the corresponding .done sentinel.
const _rawLiveOutputTtl = parseInt(process.env.MATRON_LIVE_OUTPUT_TTL || '86400', 10);
const LIVE_OUTPUT_TTL = Number.isFinite(_rawLiveOutputTtl) && _rawLiveOutputTtl > 0 ? _rawLiveOutputTtl : 86400;
const liveOutputStore = createLiveOutputStore({ ttlSeconds: LIVE_OUTPUT_TTL });
sweepOrphanedLogs('/tmp', LIVE_OUTPUT_TTL);
setInterval(() => liveOutputStore.gcExpired(), 60_000).unref();
if (!HMAC_SECRET || !VIEWER_BASE_URL) {
  console.warn('[live-output] HMAC_SECRET or VIEWER_BASE_URL unset — live-output tiles disabled');
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function generateFileLink(filePath) {
  if (!HMAC_SECRET || !VIEWER_BASE_URL) return null;
  const exp = Math.floor((Date.now() + LINK_EXPIRY_MS) / 1000);
  const payload = Buffer.from(JSON.stringify({ path: filePath, exp })).toString('base64url');
  const sig = createHmac('sha256', HMAC_SECRET).update(payload).digest('base64url');
  return `${VIEWER_BASE_URL}/view?token=${payload}.${sig}`;
}

function generateActionLink(action, roomId, extras) {
  if (!HMAC_SECRET || !VIEWER_BASE_URL) return null;
  const exp = Math.floor((Date.now() + LINK_EXPIRY_MS) / 1000);
  const payload = Buffer.from(JSON.stringify({ action, roomId, exp, ...extras })).toString('base64url');
  const sig = createHmac('sha256', HMAC_SECRET).update(payload).digest('base64url');
  return `${VIEWER_BASE_URL}/action?token=${payload}.${sig}`;
}

function generateSecretLink(secretId, label, roomId) {
  if (!HMAC_SECRET || !VIEWER_BASE_URL) return null;
  const exp = Math.floor((Date.now() + LINK_EXPIRY_MS) / 1000);
  const payload = Buffer.from(JSON.stringify({ secretId, label, roomId, exp })).toString('base64url');
  const sig = createHmac('sha256', HMAC_SECRET).update(payload).digest('base64url');
  return `${VIEWER_BASE_URL}/secret?token=${payload}.${sig}`;
}

function generateSensitiveLink(sensitiveId, label, ttl) {
  if (!HMAC_SECRET || !VIEWER_BASE_URL) return null;
  const exp = Math.floor((Date.now() + ttl * 1000) / 1000);
  const payload = Buffer.from(JSON.stringify({ sensitiveId, label, exp })).toString('base64url');
  const sig = createHmac('sha256', HMAC_SECRET).update(payload).digest('base64url');
  return `${VIEWER_BASE_URL}/sensitive?token=${payload}.${sig}`;
}



function debug(...args) {
  if (DEBUG) console.log('[DEBUG]', ...args);
}

const BRIDGE_PERMISSIONS = {
  allow: [
    'Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)', 'MultiEdit(*)',
    'Glob(*)', 'Grep(*)', 'WebFetch(*)', 'WebSearch(*)',
    'Skill', 'Agent(*)', 'Task(*)', 'NotebookEdit(*)',
  ],
  deny: [],
};
// --- Session Persistence ---

const LAST_EVENT_TS_FILE = path.join(os.homedir(), '.claude-matrix-bot-last-event-ts');

function loadLastEventTsMap() {
  try {
    const raw = fs.readFileSync(LAST_EVENT_TS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    // Migrate from old single-number format
    if (typeof parsed === 'number') return {};
    return parsed || {};
  } catch { return {}; }
}

let lastEventTsMap = loadLastEventTsMap();
let lastEventTsDirty = false;
const botStartupTs = Date.now();

function saveLastEventTsMap() {
  if (!lastEventTsDirty) return;
  try {
    fs.writeFileSync(LAST_EVENT_TS_FILE, JSON.stringify(lastEventTsMap));
    lastEventTsDirty = false;
  } catch {}
}

// Flush per-room timestamps periodically rather than on every event
setInterval(saveLastEventTsMap, 5000);

function loadPersistedSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load sessions file:', e.message);
  }
  return {};
}

function savePersistedSessions(data) {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save sessions file:', e.message);
  }
}

function persistSession(roomId, sessionId, workdir, originRoomId, extra) {
  const data = loadPersistedSessions();
  const existing = data[String(roomId)] || {};
  // Auto-carry session-scoped fields (mcpExtras) from the live session if the
  // caller didn't override them — most persistSession sites only know about
  // the field they're updating (chatHistory, pendingPlanDenialId, etc.) and
  // shouldn't have to remember to forward unrelated session state.
  const live = sessions.get(roomId);
  const derived = {};
  if (live && Array.isArray(live.mcpExtras)) derived.mcpExtras = live.mcpExtras;
  if (live && live.worktree) derived.worktree = live.worktree;
  data[String(roomId)] = {
    ...existing,
    ...derived,
    sessionId,
    workdir,
    lastUsed: Date.now(),
    originRoomId: originRoomId || null,
    ...(extra || {}),
  };
  savePersistedSessions(data);
}

function getPersistedSession(roomId) {
  const data = loadPersistedSessions();
  return data[String(roomId)] || null;
}

// --- Session Manager ---

const sessions = new Map(); // roomId -> session

function isWorktreeInUse(worktreeName, workdir, excludeRoomId) {
  for (const [rid, s] of sessions) {
    if (rid === excludeRoomId) continue;
    if (s.alive && s.worktree === worktreeName && s.workdir === workdir) return true;
  }
  return false;
}

function createSession(roomId, workdir, resumeSessionId, options = {}) {
  if (INTERACTIVE_MODE) {
    return createInteractiveSessionForRoom(roomId, workdir, resumeSessionId, options);
  }
  const cwd = expandHome(workdir || DEFAULT_WORKDIR);
  // Per-room live-bash-output gate. Defaults on; toggled via !show_bash.
  // showBashOutput is persisted via persistSession on toggle and re-read here at
  // spawn so the hook env stays in sync with the room's setting across restarts.
  // Unset (undefined) means "never toggled" → use the default (on).
  const persistedForRoom = getPersistedSession(roomId);
  const showBashOutputAtSpawn = persistedForRoom?.showBashOutput !== false;
  // mcpExtras: explicit caller-supplied value wins (used by /start, /resume,
  // /workdir handlers that parsed user flags); otherwise fall back to whatever
  // was persisted for this room so /restart and bridge restarts honour the
  // session's previous choice.
  const mcpExtras = Array.isArray(options.mcpExtras)
    ? options.mcpExtras
    : (Array.isArray(persistedForRoom?.mcpExtras) ? persistedForRoom.mcpExtras : []);
  const args = [
    '--print',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--disallowed-tools', 'AskUserQuestion',
    '--append-system-prompt', BRIDGE_SYSTEM_PROMPT,
    '--include-partial-messages',
    '--mcp-config', mcpConfigPathFor(mcpExtras),
    '--settings', JSON.stringify({
      permissions: BRIDGE_PERMISSIONS,
      hooks: {
        PreCompact: [{
          hooks: [{
            type: 'command',
            command: path.join(__dirname, 'hooks', 'compact-notify.sh'),
            timeout: 5,
          }],
        }],
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [{
            type: 'command',
            command: path.join(__dirname, 'hooks', 'matron-bash-tee.sh'),
          }],
        }],
      },
    }),
  ];
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  // --worktree <name>: spawn Claude in an isolated git worktree. Claude
  // handles creation (`.claude/worktrees/<name>`) and branch management
  // (`worktree-<name>`). Useful for parallel sessions that shouldn't
  // share filesystem state. Explicit option wins; fall back to persisted
  // value so resume/restart/auto-resume preserve isolation.
  const worktreeName = options.worktree || persistedForRoom?.worktree || null;
  if (worktreeName) {
    args.push('--worktree', worktreeName);
  }

  debug(`Spawning claude with args: ${args.join(' ')}`);
  debug(`Working directory: ${cwd}`);

  // Ensure the node binary running the bridge is reachable from the spawned
  // claude process. The ask-user MCP server and the matron-tee Bash hook both
  // resolve `node` via PATH; when the bridge is launched non-interactively
  // (e.g. launchd) nvm hasn't loaded and PATH lacks the node bin dir.
  const nodeBinDir = path.dirname(process.execPath);
  const existingPath = process.env.PATH || '';
  const pathWithNode = existingPath.split(':').includes(nodeBinDir)
    ? existingPath
    : `${nodeBinDir}:${existingPath}`;

  const proc = spawn('claude', args, {
    cwd,
    env: {
      ...process.env,
      PATH: pathWithNode,
      CLAUDECODE: '',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
      BRIDGE_ROOM_ID: roomId,
      MATRIX_BRIDGE_API_PORT: String(API_PORT),
      // Env is fixed at spawn time; toggling the flag later requires
      // !restart to take effect.
      MATRON_BASH_TEE_ENABLED: showBashOutputAtSpawn ? '1' : '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const session = {
    proc,
    roomId,
    workdir: cwd,
    worktree: worktreeName,
    mcpExtras,
    responseBuffer: '',
    sendCallback: null,
    pendingPlan: null,
    pendingPlanDenialId: resumeSessionId ? (getPersistedSession(roomId)?.pendingPlanDenialId || null) : null,
    sendHtml: null,
    showWorking: false,
    showBashOutput: showBashOutputAtSpawn,
    alive: true,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    restartCount: 0,
    claudeSessionId: resumeSessionId || null,
    busy: false,
    lineBuf: '',
    toolCalls: [], // collected tool indicators for this turn
    waitingForAnswer: null,
    // Per-session room tracking
    originRoomId: null,
    firstMessageCaptured: false,
    // Captured from system init event
    initData: null,
    // Accumulated usage stats
    totalUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, cost_usd: 0 },
    turnCount: 0,
    // Chat history for topic summarization
    chatHistory: [],         // { role, text } - full messages (code/tools stripped)
    pinnedSummaryEventId: null, // event ID of pinned summary message
    pinnedSummaryText: '',       // accumulated summary text (source of truth, not Matrix)
    pendingWelcome: true,    // whether to send welcome on user join
  };

  // Parse newline-delimited JSON from stdout
  proc.stdout.on('data', (chunk) => {
    session.lineBuf += chunk.toString();
    const lines = session.lineBuf.split('\n');
    // Keep the last (possibly incomplete) line in the buffer
    session.lineBuf = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch (_e) {
        debug('Failed to parse JSON line:', trimmed);
        continue;
      }

      debug('Event:', JSON.stringify(event));
      handleClaudeEvent(session, event);
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    debug('stderr:', text);
  });

  proc.on('close', (exitCode) => {
    session.alive = false;
    debug(`Claude process exited with code ${exitCode}`);

    if (session.subagentWatcher) {
      session.subagentWatcher.stop().catch(() => {});
      session.subagentWatcher = null;
    }
    // Drop any pending MCP questions tied to this room — the ask-user MCP
    // server died with the child, so the polling loop is gone.
    for (const [qid, entry] of pendingMcpQuestions) {
      if (entry.roomId === session.roomId) pendingMcpQuestions.delete(qid);
    }

    // Flush any remaining response
    flushResponse(session);

    if (sessions.get(roomId) === session) {
      if (session._autoStopped) {
        // Idle reaper already posted its own notice; just clean up.
        sessions.delete(roomId);
      } else if (exitCode !== 0 && session.restartCount < 3 && !session._resumeFailed) {
        // Don't auto-restart if the workdir or worktree was removed (e.g.
        // worktree cleaned up after merge). The session is legitimately over.
        const cwdGone = !fs.existsSync(cwd);
        const wtGone = session.worktree && !fs.existsSync(path.join(cwd, '.claude', 'worktrees', session.worktree));
        if (cwdGone || wtGone) {
          sessions.delete(roomId);
          const notice = '▌ Session workdir no longer exists (worktree removed after merge?). Use !start to begin a new session.';
          if (session.sendCallback) session.sendCallback(notice);
          return;
        }
        // Pass mcpExtras explicitly: createSession can fall back to persisted
        // state, but a print-mode session that crashes before its session_id
        // is delivered hasn't been persisted yet, and would silently respawn
        // without the user's --browser opt-in.
        const restarted = createSession(roomId, cwd, session.claudeSessionId, { mcpExtras: session.mcpExtras, worktree: session.worktree });
        restarted.restartCount = session.restartCount + 1;
        restarted.sendCallback = session.sendCallback;
        restarted.sendHtml = session.sendHtml;
        restarted.sendButtonMessage = session.sendButtonMessage;
        restarted.originRoomId = session.originRoomId;
        restarted.firstMessageCaptured = session.firstMessageCaptured;
        // Carry an undelivered --prompt across the restart (iv-mode only; undefined
        // and harmless in print mode). The replacement keeps pendingWelcome=true, so
        // a crash before the operator joins still fires the prompt on their join.
        restarted.pendingAutoPrompt = session.pendingAutoPrompt;
        // Carry user-visible state across the restart so the user doesn't
        // silently lose queued messages or per-room toggles.
        restarted.queuedMessages = session.queuedMessages;
        restarted.queueNotifications = session.queueNotifications;
        restarted.showWorking = session.showWorking;
        restarted.showBashOutput = session.showBashOutput;
        sessions.set(roomId, restarted);
        if (restarted.sendHtml) {
          const n = notice('warning',
            `[Session crashed (exit ${exitCode}), restarted automatically — attempt ${restarted.restartCount}/3]`,
            `Session crashed (exit ${exitCode}), restarted automatically — attempt <b>${restarted.restartCount}/3</b>`);
          restarted.sendHtml(n.plain, n.html);
        } else if (restarted.sendCallback) {
          restarted.sendCallback(
            `[Session crashed (exit ${exitCode}), restarted automatically — attempt ${restarted.restartCount}/3]`
          );
        }
      } else {
        sessions.delete(roomId);
        if (session.sendHtml) {
          const n = notice('error', `[Session ended (exit ${exitCode})]`, `Session ended (exit <code>${exitCode}</code>)`);
          session.sendHtml(n.plain, n.html);
        } else if (session.sendCallback) {
          session.sendCallback(`[Session ended (exit ${exitCode})]`);
        }
      }
    }
  });

  session.resetTimeout = () => {}; // no-op, kept for call-site compatibility

  // Subagent activity is surfaced on demand: notifyTaskStarted() runs when
  // the parent's stream emits a Task tool_use. The watcher object is cheap
  // to construct; it doesn't poll until the first Task fires.
  if (session.claudeSessionId) {
    session.subagentWatcher = new SubagentWatcher({ workdir: cwd, sessionId: session.claudeSessionId, worktreeName: session.worktree });
    session.subagentWatcher.on('subagent-event', payload => handleSubagentEvent(session, payload));
    session.subagentWatcher.snapshot();
  }

  sessions.set(roomId, session);
  return session;
}

// --- Interactive-mode session (MATRON_INTERACTIVE_MODE=1) ---
//
// Spawns claude in a PTY instead of --print. Events come from the on-disk
// JSONL transcript (via TranscriptTail), turn-end comes from the Stop hook,
// plan approval comes from the PreToolUse:ExitPlanMode hook. Returns a
// session object with the same shape as createSession() so downstream code
// (Matrix posting, queue management, restart) is unchanged.
function createInteractiveSessionForRoom(roomId, workdir, resumeSessionId, options = {}) {
  const cwd = expandHome(workdir || DEFAULT_WORKDIR);
  const persistedForRoom = getPersistedSession(roomId);
  const showBashOutputAtSpawn = persistedForRoom?.showBashOutput !== false;
  const mcpExtras = Array.isArray(options.mcpExtras)
    ? options.mcpExtras
    : (Array.isArray(persistedForRoom?.mcpExtras) ? persistedForRoom.mcpExtras : []);
  const sessionId = resumeSessionId || randomUUID();

  const settings = {
    permissions: {
      allow: [
        'Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)', 'MultiEdit(*)', 'Glob(*)', 'Grep(*)',
        'WebFetch(*)', 'WebSearch(*)', 'Skill', 'Agent(*)', 'Task(*)', 'NotebookEdit(*)',
      ],
      deny: [],
    },
    hooks: {
      PreCompact: [{
        hooks: [{ type: 'command', command: path.join(__dirname, 'hooks', 'compact-notify.sh'), timeout: 5 }],
      }],
      // ExitPlanMode is NOT intercepted in iv-mode. Claude's own in-TUI
      // confirmation prompt ("Yes / Yes, manually / Refine / Tell Claude
      // what to change") is caught by lib/prompt-detector.js and routed
      // through Matrix as a numbered question — that's the single approval
      // round. The hook+/plan-decision flow remains in print-mode only.
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: path.join(__dirname, 'hooks', 'matron-bash-tee.sh') }] },
      ],
      Stop: [{
        hooks: [{ type: 'command', command: path.join(__dirname, 'hooks', 'stop-notify.sh'), timeout: 10 }],
      }],
    },
  };

  // The CLI rejects --session-id + --resume together unless --fork-session
  // is also passed. For fresh sessions we pre-assign --session-id so we know
  // the transcript path before spawn; for resumes we pass --resume only and
  // rely on the already-known sessionId for the transcript path.
  const claudeArgs = [];
  if (resumeSessionId) {
    claudeArgs.push('--resume', resumeSessionId);
  } else {
    claudeArgs.push('--session-id', sessionId);
  }
  const worktreeName = options.worktree || persistedForRoom?.worktree || null;
  claudeArgs.push(
    // AskUserQuestion is allowed in iv-mode: the TUI prompt detector
    // (lib/prompt-detector.js) catches it and routes the question through
    // Matrix. Print-mode kept it disallowed because there was no way to
    // surface the TUI prompt; that constraint no longer applies.
    '--append-system-prompt', BRIDGE_SYSTEM_PROMPT,
    '--mcp-config', mcpConfigPathFor(mcpExtras),
    '--settings', JSON.stringify(settings),
  );
  if (worktreeName) {
    claudeArgs.push('--worktree', worktreeName);
  }

  const nodeBinDir = path.dirname(process.execPath);
  const existingPath = process.env.PATH || '';
  const pathWithNode = existingPath.split(':').includes(nodeBinDir) ? existingPath : `${nodeBinDir}:${existingPath}`;

  const encodedCwd = encodeProjectDir(cwd);
  const worktreeTranscriptPath = worktreeName
    ? path.join(os.homedir(), '.claude', 'projects', `${encodedCwd}--claude-worktrees-${worktreeName}`, `${sessionId}.jsonl`)
    : undefined;

  debug(`Spawning interactive claude session ${sessionId} in ${cwd}${worktreeName ? ` (worktree: ${worktreeName})` : ''}`);

  const iv = createInteractiveSession({
    roomId,
    workdir: cwd,
    sessionId,
    claudeArgs,
    transcriptPath: worktreeTranscriptPath,
    env: {
      ...process.env,
      PATH: pathWithNode,
      CLAUDECODE: '',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
      BRIDGE_ROOM_ID: roomId,
      MATRIX_BRIDGE_API_PORT: String(API_PORT),
      MATRON_BASH_TEE_ENABLED: showBashOutputAtSpawn ? '1' : '0',
    },
  });

  // Same shape as the --print session object. `proc` is null in iv mode;
  // call sites that need raw input go via session.iv.sendText / sendKeystroke
  // (wired up in Task 4.2).
  const session = {
    proc: null,
    iv,
    roomId,
    workdir: cwd,
    worktree: worktreeName,
    mcpExtras,
    responseBuffer: '',
    sendCallback: null,
    pendingPlan: null,
    pendingPlanDenialId: resumeSessionId ? (getPersistedSession(roomId)?.pendingPlanDenialId || null) : null,
    sendHtml: null,
    sendButtonMessage: null,
    showWorking: false,
    showBashOutput: showBashOutputAtSpawn,
    alive: true,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    restartCount: 0,
    claudeSessionId: sessionId,
    busy: false,
    lineBuf: '',
    toolCalls: [],
    waitingForAnswer: null,
    originRoomId: null,
    firstMessageCaptured: false,
    initData: null,
    totalUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, cost_usd: 0 },
    turnCount: 0,
    chatHistory: [],
    pinnedSummaryEventId: null,
    pinnedSummaryText: '',
    pendingWelcome: true,
    pendingInteractivePrompt: null,
    // Auto-injected prompt for --prompt dispatch (distinct from pendingInteractivePrompt,
    // the TUI dialog). Set post-create by the !start handler; fired by the join handler
    // (sendPendingWelcomeIfNeeded) once the operator joins and keys are shared.
    pendingAutoPrompt: null,
    ivReady: false,
    ivPendingInput: null,
  };

  function markIvReady() {
    if (session.ivReady) return;
    session.ivReady = true;
    debug(`[IV] Session marked ready, pending input: ${!!session.ivPendingInput}`);
    if (session.ivPendingInput) {
      const pending = session.ivPendingInput;
      session.ivPendingInput = null;
      sendToSession(session, pending);
    }
    // Fire a join-armed auto-prompt AFTER draining any operator input, now that the
    // TUI is ready (so it writes straight to the PTY, never into the single-slot
    // ivPendingInput stash where it could be overwritten). Set by sendPendingWelcomeIfNeeded.
    if (session._fireAutoPromptWhenReady) {
      const fire = session._fireAutoPromptWhenReady;
      session._fireAutoPromptWhenReady = null;
      fire();
    }
  }

  let _ivPtyBuf = '';
  iv.on('pty-data', chunk => {
    if (session.ivReady) return;
    _ivPtyBuf += chunk;
    if (_ivPtyBuf.length > 4096) _ivPtyBuf = _ivPtyBuf.slice(-2048);
    if (_ivPtyBuf.includes('/effort')) {
      debug('[IV] Detected toolbar in PTY output — TUI is ready');
      _ivPtyBuf = '';
      markIvReady();
    }
  });

  iv.on('event', event => {
    debug('IV event:', event.type);
    handleClaudeEvent(session, event);
  });

  iv.on('screen-update', update => {
    debug('IV screen-update:', update.urls.length, 'url(s)', 'cue=' + update.hasInputCue);
    handleInteractiveScreenUpdate(session, update);
  });

  iv.on('prompt', prompt => {
    debug('IV prompt:', prompt.kind, prompt.question);
    markIvReady();
    session.pendingInteractivePrompt = prompt;
    // A TUI prompt means claude has stopped processing and is awaiting
    // user input. The Stop hook is unreliable for these states (e.g.
    // first-run modals, /login, unauthenticated "please run /login"
    // pseudo-turns) — without this the bridge's `busy` flag gets stuck
    // and every subsequent user message hits the queue path.
    if (session.busy) {
      // [QUEUE-PROBE] working=true here = busy cleared while Claude is still
      // generating → opens the window where the next message bypasses the queue.
      const __q = probePtyState(session);
      console.log(`[QUEUE-PROBE] BUSY-CLEAR via=iv-prompt kind=${prompt.kind} idleReady=${__q.idleReady} working=${__q.working} room=${session.roomId.slice(1, 7)}`);
      console.log(`[IV-DEBUG] Clearing busy=true on iv-prompt (kind=${prompt.kind})`);
      session.busy = false;
      if (session.typingInterval) {
        clearInterval(session.typingInterval);
        session.typingInterval = null;
        client.setTyping(session.roomId, false, 1000).catch(() => {});
      }
    }
    handleInteractivePrompt(session, prompt);
  });

  iv.on('parseError', err => {
    debug('IV transcript parse error:', err.line?.slice(0, 80));
  });

  iv.on('exit', exitCode => {
    session.alive = false;
    debug(`Interactive claude session ${sessionId} exited code=${exitCode}`);
    if (session.subagentWatcher) {
      session.subagentWatcher.stop().catch(() => {});
      session.subagentWatcher = null;
    }
    // Drop any pending MCP questions tied to this room — see createSession()
    // for rationale.
    for (const [qid, entry] of pendingMcpQuestions) {
      if (entry.roomId === session.roomId) pendingMcpQuestions.delete(qid);
    }
    flushResponse(session);
    if (sessions.get(roomId) === session) {
      if (session._autoStopped) {
        // Idle reaper already posted its own notice; just clean up.
        sessions.delete(roomId);
      } else if (exitCode !== 0 && session.restartCount < 3 && !session._resumeFailed) {
        const cwdGone = !fs.existsSync(cwd);
        const wtGone = session.worktree && !fs.existsSync(path.join(cwd, '.claude', 'worktrees', session.worktree));
        if (cwdGone || wtGone) {
          sessions.delete(roomId);
          const notice = '▌ Session workdir no longer exists (worktree removed after merge?). Use !start to begin a new session.';
          if (session.sendCallback) session.sendCallback(notice);
          return;
        }
        // Pass mcpExtras explicitly (see the matching block in print-mode
        // createSession): the persistence-fallback in createSession can miss
        // a fresh session that crashed before its first persist.
        const restarted = createSession(roomId, cwd, session.claudeSessionId, { mcpExtras: session.mcpExtras, worktree: session.worktree });
        restarted.restartCount = session.restartCount + 1;
        restarted.sendCallback = session.sendCallback;
        restarted.sendHtml = session.sendHtml;
        restarted.sendButtonMessage = session.sendButtonMessage;
        restarted.originRoomId = session.originRoomId;
        restarted.firstMessageCaptured = session.firstMessageCaptured;
        // Carry an undelivered --prompt across the restart (iv-mode only; undefined
        // and harmless in print mode). The replacement keeps pendingWelcome=true, so
        // a crash before the operator joins still fires the prompt on their join.
        restarted.pendingAutoPrompt = session.pendingAutoPrompt;
        // Carry user-visible state across the restart so the user doesn't
        // silently lose queued messages or per-room toggles.
        restarted.queuedMessages = session.queuedMessages;
        restarted.queueNotifications = session.queueNotifications;
        restarted.showWorking = session.showWorking;
        restarted.showBashOutput = session.showBashOutput;
        sessions.set(roomId, restarted);
        if (restarted.sendHtml) {
          const n = notice('warning',
            `[Session crashed (exit ${exitCode}), restarted automatically — attempt ${restarted.restartCount}/3]`,
            `Session crashed (exit ${exitCode}), restarted automatically — attempt <b>${restarted.restartCount}/3</b>`);
          restarted.sendHtml(n.plain, n.html);
        } else if (restarted.sendCallback) {
          restarted.sendCallback(`[Session crashed (exit ${exitCode}), restarted automatically — attempt ${restarted.restartCount}/3]`);
        }
      } else {
        sessions.delete(roomId);
        if (session.sendHtml) {
          const n = notice('error', `[Session ended (exit ${exitCode})]`, `Session ended (exit <code>${exitCode}</code>)`);
          session.sendHtml(n.plain, n.html);
        } else if (session.sendCallback) {
          session.sendCallback(`[Session ended (exit ${exitCode})]`);
        }
      }
    }
  });

  session.resetTimeout = () => {};

  // iv-mode turn-end handler. Print-mode does most of this work in
  // case 'result' inside handleClaudeEvent; the transcript file in iv-mode
  // has no result event, so the Stop hook (→ /turn-end → this) replaces it.
  session.onTurnEnd = () => {
    debug(`[IV] onTurnEnd called, room=${session.roomId}, bufLen=${session.responseBuffer.length}, sendCallback=${!!session.sendCallback}, sendHtml=${!!session.sendHtml}`);
    // Flush the accumulated assistant text to Matrix.
    if (session.responseBuffer.trim() && !session.waitingForAnswer) {
      flushResponse(session);
    }
    // Emit collected tool-call summary if the user has !show_working on.
    if (session.toolCalls.length > 0 && session.showWorking && session.sendCallback) {
      const toolSummary = session.toolCalls.join('\n');
      const chunks = splitMessage(toolSummary);
      for (const chunk of chunks) session.sendCallback(chunk);
    }
    session.toolCalls = [];
    session.turnCount++;
    session.busy = false;
    stripQueueNotificationLinks(session);
    if (session.typingInterval) {
      clearInterval(session.typingInterval);
      session.typingInterval = null;
      client.setTyping(session.roomId, false, 1000).catch(() => {});
    }
    // Flush any queued messages now that claude is free.
    if (session.queuedMessages && session.queuedMessages.length > 0 && !session.waitingForAnswer) {
      const queued = session.queuedMessages;
      session.queuedMessages = null;
      const summary = formatQueueSummary(queued);
      if (session.sendHtml) {
        session.sendHtml(
          `📬 Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''}:\n${summary.plain}`,
          `<b>📬 Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''}:</b>${summary.html}`,
        );
      } else if (session.sendCallback) {
        session.sendCallback(`📬 Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''}:\n${summary.plain}`);
      }
      flushQueue(session, queued);
    }
  };

  // /plan-decision HTTP handler calls this when claude's ExitPlanMode hook
  // fires. We post the plan to Matrix and stash the tool_use_id so that
  // the "build" handler in the message loop can call
  // pendingPlanDecisions.get(toolUseId).resolve(...) when the user replies.
  session.requestPlanDecision = (toolUseId, planText) => {
    session.ivPendingPlanToolUseId = toolUseId;
    session.pendingPlan = planText || '';
    const preview = (planText || '').length > 500
      ? (planText || '').slice(0, 500) + '…'
      : (planText || '');
    const plainPlan = `--- Plan Ready ---\n\n${preview}\n\nReply "build" to execute, or send feedback.`;
    if (session.sendHtml) {
      const htmlPlan =
        `<b>📋 Plan Ready</b><blockquote>${markdownToHtml(preview)}</blockquote>` +
        `Reply <code>build</code> to execute, or send feedback.`;
      session.sendHtml(plainPlan, htmlPlan);
    } else if (session.sendCallback) {
      session.sendCallback(plainPlan);
    } else {
      // No Matrix output channel yet — auto-deny so the hook unblocks.
      const pending = pendingPlanDecisions.get(toolUseId);
      if (pending) pending.resolve({ decision: 'deny', reason: 'no Matrix output channel for session' });
    }
  };

  const readyTimer = setTimeout(() => {
    if (!session.ivReady) {
      debug('[IV] Readiness timeout (30s) — forcing ready');
      markIvReady();
    }
  }, 30000);
  if (typeof readyTimer.unref === 'function') readyTimer.unref();

  // Subagent activity watcher — see createSession() for the rationale.
  session.subagentWatcher = new SubagentWatcher({ workdir: cwd, sessionId, worktreeName });
  session.subagentWatcher.on('subagent-event', payload => handleSubagentEvent(session, payload));
  session.subagentWatcher.snapshot();

  sessions.set(roomId, session);
  return session;
}

// Surface a detected TUI prompt to Matrix as a multiple-choice question.
function handleInteractivePrompt(session, prompt) {
  if (!session.sendHtml && !session.sendCallback) return;
  const optionLines = prompt.options.map((opt, i) => `${i + 1}. ${opt.label}${opt.selected ? ' (current)' : ''}`);
  // When the prompt has a detected free-text slot (e.g. "Tell Claude what
  // to change"), tell the user they can reply with text directly. We'll
  // route the reply to that option and pipe their text into the TUI.
  const ftIdx = prompt.freeTextIdx;
  const ftLabel = (typeof ftIdx === 'number') ? (prompt.options[ftIdx]?.label || '') : '';
  const helpPlain = [
    `Reply with the option number (1–${prompt.options.length})`,
    prompt.kind === 'yes-no' ? ' or "y" / "n"' : '',
    ftLabel ? `, or send any other text to ${JSON.stringify(ftLabel)}` : '',
    '.',
  ].join('');
  const plain = [
    'Claude is asking:',
    prompt.question || '',
    '',
    ...optionLines,
    '',
    helpPlain,
  ].filter(Boolean).join('\n');
  if (session.sendHtml) {
    const htmlOptions = prompt.options.map((opt, i) =>
      `<b>${i + 1}.</b> ${escapeHtml(opt.label)}${opt.selected ? ' <i>(current)</i>' : ''}`
    ).join('<br/>');
    const helpHtml =
      `Reply with the option number (1–${prompt.options.length})` +
      (prompt.kind === 'yes-no' ? ' or <code>y</code> / <code>n</code>' : '') +
      (ftLabel ? `, or send any other text to <i>${escapeHtml(ftLabel)}</i>` : '') +
      '.';
    const html =
      `<b>🟡 Claude is asking:</b><br/>` +
      (prompt.question ? `<i>${escapeHtml(prompt.question)}</i><br/><br/>` : '') +
      htmlOptions +
      `<br/><br/>${helpHtml}`;
    session.sendHtml(plain, html);
  } else {
    session.sendCallback(plain);
  }
}

// If the session has a pending TUI prompt and the user's message looks like
// a valid response, send the keystroke and return true (so the message isn't
// also forwarded to claude as a regular user message).
function maybeResolveInteractivePrompt(session, userText) {
  const p = session.pendingInteractivePrompt;
  if (!p) return false;
  const trimmed = (userText || '').trim().toLowerCase();
  let response = null;
  if (p.kind === 'yes-no') {
    if (/^(y|yes|1)$/.test(trimmed)) response = { kind: 'yes-no', key: 'y' };
    else if (/^(n|no|2)$/.test(trimmed)) response = { kind: 'yes-no', key: 'n' };
  } else {
    const n = parseInt(trimmed, 10);
    if (Number.isFinite(n) && n >= 1 && n <= p.options.length) {
      const opt = p.options[n - 1];
      if (p.kind === 'arrow-menu') {
        response = { kind: 'arrow-menu', key: String(n - 1) };
      } else {
        response = { kind: p.kind, key: opt.key };
      }
    } else if (p.kind === 'lettered' && /^[a-z]$/.test(trimmed)) {
      response = { kind: 'lettered', key: trimmed };
    }
  }
  if (!response) {
    // No numeric/letter match. If the prompt has a free-text slot (e.g.
    // "Tell Claude what to change"), select that option and pipe the
    // user's text into the TUI's text input. Otherwise, ask the user to
    // retry with a valid option.
    if (typeof p.freeTextIdx === 'number' && p.freeTextIdx >= 0 && p.freeTextIdx < p.options.length) {
      const idx = p.freeTextIdx;
      const opt = p.options[idx];
      const ftResponse = p.kind === 'arrow-menu'
        ? { kind: 'arrow-menu', key: String(idx) }
        : { kind: p.kind, key: opt.key };
      session.pendingInteractivePrompt = null;
      session.iv.respondToPrompt(ftResponse);
      // Give the TUI a beat to transition from the menu into the text
      // input area, then paste the user's reply (sendText handles the
      // bracketed-paste + delayed Enter dance).
      setTimeout(() => {
        if (session.iv && session.iv.alive) {
          session.iv.sendText(userText);
        }
      }, 250);
      return true;
    }
    // Unmatched reply: dismiss the prompt and let the message through to
    // Claude as normal input. This prevents false-positive detections from
    // blocking the user's free-form messages.
    session.pendingInteractivePrompt = null;
    return false;
  }
  // Resolve the human-readable label so the Matrix confirmation tells the
  // user *what* we sent to claude — without this, the bridge silently
  // consumed the reply and the user thought it had been ignored.
  let pickedLabel = null;
  let pickedNumber = null;
  if (p.kind === 'yes-no') {
    pickedLabel = response.key === 'y' ? 'Yes' : 'No';
  } else {
    const n = parseInt(trimmed, 10);
    if (Number.isFinite(n) && n >= 1 && n <= p.options.length) {
      pickedNumber = n;
      pickedLabel = p.options[n - 1].label;
    } else if (p.kind === 'lettered' && /^[a-z]$/.test(trimmed)) {
      const opt = p.options.find(o => o.key === trimmed);
      pickedLabel = opt ? opt.label : trimmed.toUpperCase();
    }
  }
  session.pendingInteractivePrompt = null;
  console.log(
    `[IV-DEBUG] Resolving TUI prompt with reply="${userText}" → ` +
    `kind=${response.kind} key=${response.key}` +
    (pickedLabel ? ` label="${pickedLabel}"` : '')
  );
  session.iv.respondToPrompt(response);
  // Tell the Matrix user we received their reply and what we sent on
  // their behalf. Without this the consumption is invisible.
  const numberPrefix = pickedNumber !== null ? `${pickedNumber}. ` : '';
  const ackPlain = `→ Sent "${numberPrefix}${pickedLabel || response.key}" to Claude`;
  const ackHtml = `<i>→ Sent <b>${escapeHtml(numberPrefix + (pickedLabel || response.key))}</b> to Claude</i>`;
  if (session.sendHtml) session.sendHtml(ackPlain, ackHtml);
  else if (session.sendCallback) session.sendCallback(ackPlain);
  // Start typing while we wait for claude's next render — without this
  // the user sees no activity until the next prompt or text fires.
  if (session.typingInterval) clearInterval(session.typingInterval);
  session.typingInterval = startTyping(session.roomId);
  return true;
}

// Iteratively rejoin URLs that claude wrapped at terminal width. We only
// merge a `\n` into a URL when the next line begins with characters that
// can only be URL continuation (no spaces, only URL-safe chars), so prose
// that happens to follow a URL stays on its own line.
function unwrapUrls(text) {
  const URL_HEAD = /(https?:\/\/[A-Za-z0-9=&/%+\-._~?#:@!*'(),;$]+)\n([A-Za-z0-9=&/%+\-._~?#]+)/g;
  let prev;
  let out = text;
  do {
    prev = out;
    out = out.replace(URL_HEAD, '$1$2');
  } while (out !== prev);
  return out;
}

// Build a clean, purpose-built Matrix message from a settled free-text
// TUI screen instead of dumping the raw PTY content. Each cue type
// (OAuth flow, press-enter ack, etc) gets its own formatter so the user
// sees a focused message — no separator bars, status chrome, OSC title
// leaks, spinner ticks, task lists, etc. Returns null when nothing
// useful can be extracted (caller should not send anything in that
// case rather than dumping the raw screen).
function formatTuiCueMessage(screen, urls) {
  // OAuth / "open this URL to sign in" flow. Triggered by /login.
  // Screen layout: "Browser didn't open? Use the url below to sign in
  // (c to copy)" + URL + "Paste code here if prompted >".
  const isOauth = /browser\s+didn'?t\s+open|use\s+the\s+url|copy\s+the\s+url|paste\s+code\s+here/i.test(screen);
  if (isOauth && urls.length > 0) {
    const url = urls[0];
    const plain =
      `🔗 Claude needs you to sign in.\n\n` +
      `Open this URL in your browser:\n${url}\n\n` +
      `After authorising, paste the code (the long string after \`#\` in the callback URL) back here.`;
    const html =
      `<b>🔗 Claude needs you to sign in.</b><br/><br/>` +
      `Open this URL in your browser:<br/>` +
      `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a><br/><br/>` +
      `After authorising, paste the code (the long string after <code>#</code> in the callback URL) back here.`;
    return { plain, html };
  }
  // Press-Enter acknowledgment (e.g. post-login "Login successful.
  // Press Enter to continue…"). Extract the result line above the cue.
  if (/press\s+enter\s+to\s+(continue|dismiss|acknowledge|proceed)/i.test(screen)) {
    const lines = screen.split('\n').map(l => l.trim()).filter(Boolean);
    const resultLine =
      lines.find(l => /logged\s+in\s+as|login\s+successful|complete[d]?|finished|✅/i.test(l)) ||
      lines.find(l => l.length > 5 && !/press\s+enter|esc\s+to/i.test(l)) ||
      'Claude is continuing…';
    const plain = `✅ ${resultLine}`;
    const html = `<b>✅ ${escapeHtml(resultLine)}</b>`;
    return { plain, html };
  }
  // Generic input cue we couldn't parse — surface a one-liner pointing
  // at the cue with any URLs, but don't dump the whole screen.
  if (urls.length > 0) {
    const plain = `Claude is asking you to act on this URL:\n${urls.join('\n')}`;
    const html =
      `<b>Claude is asking you to act on this URL:</b><br/>` +
      urls.map(u => `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>`).join('<br/>');
    return { plain, html };
  }
  return null;
}

// Surface free-text TUI output (e.g. the /login OAuth URL screen, "press
// enter to continue" notices) to Matrix. Triggered by the prompt-detector's
// `screen-update` event whenever the screen settles with URLs or input
// cues that don't classify as a structured menu — those are the only PTY
// states the user MUST see but that don't fire transcript events and
// aren't covered by the menu detector.
function handleInteractiveScreenUpdate(session, update) {
  const { screen, urls, hasInputCue } = update;
  if (!screen) return;
  if (urls.length === 0 && !hasInputCue) return;
  // Per-session URL dedup so the same OAuth URL isn't pushed twice if
  // claude redraws (e.g. spinner ticks). The detector also dedups but
  // only within one session run — we want lifetime dedup across restarts.
  session.surfacedUrls = session.surfacedUrls || new Set();
  const newUrls = urls.filter(u => !session.surfacedUrls.has(u));
  if (newUrls.length === 0 && !hasInputCue) return;
  for (const u of newUrls) session.surfacedUrls.add(u);
  // Un-wrap URLs that claude broke across lines at terminal width so
  // the parsed URL set is correct (`...redir\nect_uri=...` → joined).
  const unwrappedScreen = unwrapUrls(
    screen.split('\n').map(l => l.trim()).join('\n')
  );
  // Build a clean cue-specific message instead of dumping the raw
  // screen. If the formatter can't make sense of the cue, skip rather
  // than spam a screen-dump full of status chrome.
  const allUrls = extractUrls(unwrappedScreen);
  const message = formatTuiCueMessage(unwrappedScreen, allUrls);
  if (!message) {
    console.log(`[IV-DEBUG] Free-text TUI cue not parseable, skipping (urls=${newUrls.length}, inputCue=${hasInputCue})`);
    return;
  }
  console.log(`[IV-DEBUG] Surfacing parsed free-text TUI cue (${newUrls.length} new URL(s), inputCue=${hasInputCue})`);
  if (session.sendHtml) session.sendHtml(message.plain, message.html);
  else if (session.sendCallback) session.sendCallback(message.plain);
  // A free-text TUI cue means claude is waiting on the user just like a
  // structured prompt does — clear busy so the user's response (OAuth
  // code, "paste code here" content, etc.) gets typed straight into the
  // PTY instead of dropping into the queue. Mirrors the iv-prompt
  // handler at iv.on('prompt') in createInteractiveSessionForRoom.
  if (session.busy) {
    // [QUEUE-PROBE] working=true here = busy cleared mid-generation on a TUI
    // cue → the window where the next operator message leaks into the PTY.
    const __q = probePtyState(session);
    console.log(`[QUEUE-PROBE] BUSY-CLEAR via=screen-update inputCue=${hasInputCue} idleReady=${__q.idleReady} working=${__q.working} room=${session.roomId.slice(1, 7)}`);
    console.log(`[IV-DEBUG] Clearing busy=true on screen-update (hasInputCue=${hasInputCue})`);
    session.busy = false;
  }
  // Cancel typing — the user now has something to act on.
  if (session.typingInterval) {
    clearInterval(session.typingInterval);
    session.typingInterval = null;
    client.setTyping(session.roomId, false, 1000).catch(() => {});
  }
  // Auto-press Enter for pure acknowledgment cues ("Press Enter to
  // continue…" after /login success, "Press Enter to dismiss" notices,
  // etc). These are just waiting for any keystroke before claude moves
  // on — without this the user has to send a dummy message to unblock
  // claude, which is confusing UX. We surface the screen content FIRST
  // (so the user sees "Login successful" etc) then send Enter and a
  // small confirmation note.
  if (AUTO_ENTER_CUE_RE.test(unwrappedScreen)) {
    console.log('[IV-DEBUG] Auto-pressing Enter for "Press Enter to continue" cue');
    try {
      session.iv.sendKeystroke('enter');
    } catch (err) {
      console.error('[IV-DEBUG] Auto-Enter failed:', err.message);
      return;
    }
    const note = '↵ (auto-pressed Enter to continue)';
    if (session.sendHtml) session.sendHtml(note, `<i>${escapeHtml(note)}</i>`);
    else if (session.sendCallback) session.sendCallback(note);
  }
}

// Cues for which the bridge auto-sends Enter on the user's behalf.
// Kept narrow on purpose — only matches phrasing where claude is
// explicitly waiting for an acknowledgment keystroke ("press enter to
// continue" / "press enter to dismiss"). Does NOT match "paste code
// here" or other prompts that need real input.
const AUTO_ENTER_CUE_RE = /press\s+enter\s+to\s+(continue|dismiss|acknowledge|proceed)/i;

// --- Structured Question Handling ---

function parseAskUserQuestion(input) {
  // Handle structured questions JSON
  if (input.questions && Array.isArray(input.questions)) {
    return { questions: input.questions };
  }

  // Try parsing the question field as JSON
  const questionText = input.question || input.text || '';
  try {
    const parsed = JSON.parse(questionText);
    if (parsed.questions && Array.isArray(parsed.questions)) {
      return { questions: parsed.questions };
    }
  } catch {}

  // Simple text question
  return {
    questions: [{
      question: questionText || JSON.stringify(input),
      header: null,
      options: [],
      multiSelect: false,
    }]
  };
}

function formatQuestion(q, index, total) {
  let msg = '';
  const prefix = total > 1 ? `--- Question ${index + 1}/${total} ---` : '--- Question ---';

  if (q.header) {
    msg += `${prefix} — ${q.header}\n\n`;
  } else {
    msg += `${prefix}\n\n`;
  }

  msg += q.question + '\n';

  if (q.options && q.options.length > 0) {
    // Blank line before each option for separation; ⭐ marks a "(Recommended)" label.
    q.options.forEach((opt, i) => {
      const letter = String.fromCharCode(65 + i); // A, B, C...
      const label = typeof opt.label === 'string' ? opt.label : typeof opt === 'string' ? opt : String(opt.label ?? opt);
      const desc = opt.description || '';
      const marker = /\(recommended\)/i.test(label) ? '⭐ ' : '';
      msg += `\n${marker}${letter}. ${label}\n`;
      if (desc) {
        msg += `   ${desc}\n`;
      }
    });
    msg += `\nReply with a letter (A, B, C…) or number (1, 2, 3…), or type a custom answer.`;
  }

  return msg;
}

function formatQuestionHtml(q, index, total) {
  // Matrix custom HTML (org.matrix.custom.html) collapses raw "\n" to a single
  // space, so options separated only by newlines render as a run-on wall in
  // Element/matron-web. Use explicit <br> for line breaks and a blank line
  // (double <br>) between options so A/B/C are visually separated. An option
  // whose label is tagged "(Recommended)" gets a ⭐ marker.
  let msg = '';
  const prefix = total > 1 ? `❓ Question ${index + 1}/${total}` : '❓';

  if (q.header) {
    msg += `${prefix} — <b>${escapeHtml(q.header)}</b><br><br>`;
  } else {
    msg += `${prefix}<br><br>`;
  }

  msg += escapeHtml(q.question);

  if (q.options && q.options.length > 0) {
    q.options.forEach((opt, i) => {
      const letter = String.fromCharCode(65 + i);
      const label = typeof opt.label === 'string' ? opt.label : typeof opt === 'string' ? opt : String(opt.label ?? opt);
      const desc = opt.description || '';
      const marker = /\(recommended\)/i.test(label) ? '⭐ ' : '';
      msg += `<br><br>${marker}<b>${letter}.</b> ${escapeHtml(label)}`;
      if (desc) {
        msg += `<br><i>${escapeHtml(desc)}</i>`;
      }
    });
    msg += `<br><br>Reply with a letter (A, B, C…) or number (1, 2, 3…), or type a custom answer.`;
  }

  return msg;
}

function sendAllQuestions(session) {
  const questions = session.pendingQuestions;
  if (!questions || questions.length === 0) return;

  const total = questions.length;

  for (let i = 0; i < total; i++) {
    const q = questions[i];
    const plainText = formatQuestion(q, i, total);
    const html = formatQuestionHtml(q, i, total);

    if (q.options && q.options.length > 0 && session.sendButtonMessage) {
      // Build button array from options
      const buttons = q.options.map((opt, idx) => {
        const label = typeof opt.label === 'string' ? opt.label : typeof opt === 'string' ? opt : String(opt);
        const letter = String.fromCharCode(65 + idx);
        return {
          id: `opt_${letter.toLowerCase()}`,
          label: label,
          value: label,
        };
      });

      const prefix = total > 1 ? `Question ${i + 1}/${total}` : '';
      const prompt = prefix
        ? (q.header ? `${prefix} — ${q.header}\n\n${q.question}` : `${prefix}\n\n${q.question}`)
        : (q.header ? `${q.header}\n\n${q.question}` : q.question);

      const mode = q.multiSelect ? 'pick_many' : 'pick_one';
      console.log(`[BUTTONS] sendAllQuestions: q.multiSelect=${q.multiSelect}, mode=${mode}`);
      session.sendButtonMessage(prompt, buttons, mode, plainText, html);
    } else if (session.sendHtml) {
      session.sendHtml(plainText, html);
    } else if (session.sendCallback) {
      session.sendCallback(plainText);
    }
  }
}

function submitAnswer(session, answerText) {
  const mode = session.waitingForAnswer;
  session.waitingForAnswer = null;
  session.pendingQuestions = null;
  session.currentQuestionIndex = 0;
  session.questionAnswers = [];

  if (typeof mode === 'string' && mode.startsWith('mcp:')) {
    // MCP tool question — store the answer so the MCP server can poll for it
    const questionId = mode.slice(4);
    const q = pendingMcpQuestions.get(questionId);
    if (q) {
      q.answered = true;
      q.answer = answerText;
      // Cancel the bridge-owned expiry timer — the answer beat the timeout, so
      // expireMcpQuestion must not fire and tear down the session afterwards.
      if (q.expiryTimer) clearTimeout(q.expiryTimer);
      debug(`MCP question ${questionId} answered: ${answerText}`);
      // Start typing — Claude will continue once the MCP tool returns.
      if (session.typingInterval) clearInterval(session.typingInterval);
      session.typingInterval = startTyping(session.roomId);
    } else {
      // The question is gone — the bridge already expired it (see
      // expireMcpQuestion), which also cleared waitingForAnswer, so this is a
      // belt-and-suspenders guard: route the reply as a normal message instead
      // of arming a typing indicator that would spin forever (nothing will
      // consume this answer).
      debug(`MCP question ${questionId} already expired; routing reply as a normal message`);
      sendTextToSession(session, answerText);
    }
  } else if (mode === 'text-reply') {
    // AskUserQuestion was auto-rejected — send the answer as a regular user message
    sendTextToSession(session, answerText);
  } else {
    // Normal tool_result flow. This path only applies to print-mode stream-
    // json input; in iv-mode the ask-user MCP server returns answers over
    // its own stdio transport and this branch is unreachable. Log if it ever
    // fires under iv-mode so we notice an unexpected code path.
    if (session.iv) {
      debug('iv-mode: skipping legacy tool_result stdin.write (ask-user MCP should handle this).');
      return;
    }
    session.busy = true;
    const jsonMsg = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          tool_use_id: mode,
          type: 'tool_result',
          content: answerText,
        }]
      }
    }) + '\n';
    debug('Sending answer to stdin:', jsonMsg.trim());
    session.proc.stdin.write(jsonMsg);
    if (session.resetTimeout) session.resetTimeout();

    if (session.typingInterval) clearInterval(session.typingInterval);
    session.typingInterval = startTyping(session.roomId);
  }
}

function resolveQuestionAnswer(session, text) {
  const q = session.pendingQuestions[session.currentQuestionIndex];
  const trimmed = text.trim();

  if (q.options && q.options.length > 0) {
    // Try letter (A, B, C...)
    const upper = trimmed.toUpperCase();
    if (upper.length === 1 && upper >= 'A' && upper <= 'Z') {
      const idx = upper.charCodeAt(0) - 65;
      if (idx < q.options.length) {
        const opt = q.options[idx];
        return typeof opt.label === 'string' ? opt.label : String(opt);
      }
    }

    // Try number (1, 2, 3...)
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= q.options.length) {
      const opt = q.options[num - 1];
      return typeof opt.label === 'string' ? opt.label : String(opt);
    }
  }

  // Custom text answer
  return trimmed;
}

// --- Claude Event Handler ---

// Format a subagent tool_use block as a Matrix indicator. Returns null for
// tools we don't surface (Read/Glob/Grep/Bash/etc.) to keep the room
// usable — mirrors the parent's "key event" gating without the
// liveOutput/showWorking machinery.
function formatSubagentToolIndicator(label, toolName, input) {
  const safeLabel = `<i>${escapeHtml(label)}</i>`;
  if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') && input.file_path) {
    const verb = toolName === 'Write' ? 'Writing' : 'Editing';
    return {
      plain: `🔀[${label}] ✏️ ${verb} ${input.file_path}`,
      html: `🔀[${safeLabel}] ✏️ ${verb} <code>${escapeHtml(input.file_path)}</code>`,
    };
  }
  if (toolName === 'WebSearch' && input.query) {
    return {
      plain: `🔀[${label}] 🌐 ${input.query}`,
      html: `🔀[${safeLabel}] 🌐 <i>${escapeHtml(input.query)}</i>`,
    };
  }
  if (toolName === 'WebFetch' && input.url) {
    return {
      plain: `🔀[${label}] 🌐 ${input.url}`,
      html: `🔀[${safeLabel}] 🌐 <a href="${escapeHtml(input.url)}">${escapeHtml(input.url)}</a>`,
    };
  }
  if (toolName === 'Task' || toolName === 'Agent') {
    const desc = (input.description || input.prompt || '').slice(0, 80);
    return {
      plain: `🔀[${label}] 🔀 Nested subtask: ${desc}`,
      html: `🔀[${safeLabel}] 🔀 Nested subtask: <i>${escapeHtml(desc)}</i>`,
    };
  }
  if (toolName === 'TodoWrite' && Array.isArray(input.todos)) {
    const lines = input.todos.map(t => {
      const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬚';
      return `${icon} ${t.content || t.text || ''}`;
    });
    const htmlItems = input.todos.map(t => {
      const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬚';
      return `<li>${icon} ${escapeHtml(t.content || t.text || '')}</li>`;
    }).join('');
    return {
      plain: `🔀[${label}] 📋 Todos:\n${lines.join('\n')}`,
      html: `🔀[${safeLabel}] 📋 <b>Todos:</b><ul>${htmlItems}</ul>`,
    };
  }
  return null;
}

function handleSubagentEvent(session, { label, event }) {
  if (!session || !session.alive) return;
  if (!event || !event.message) return;
  const content = event.message.content;
  if (!Array.isArray(content)) return;

  if (event.type === 'assistant') {
    // Subagent transcripts on disk write each reasoning message as its
    // own event with its own messageId. Intermediate "let me check X"
    // narration between tool calls comes with stop_reason=null; only the
    // final answer gets stop_reason=end_turn. We post all of them —
    // skipping null would silence most subagent activity, and short
    // subagents sometimes never emit an end_turn at all.

    const textParts = content.filter(b => b.type === 'text' && b.text).map(b => b.text);
    if (textParts.length > 0) {
      const text = textParts.join('').trim();
      const isFiller = textParts.length === 1 && /^\s*No response requested\.?\s*$/.test(textParts[0]);
      if (text && !isFiller) {
        const prefix = `🔀[${label}] `;
        const htmlPrefix = `🔀[<i>${escapeHtml(label)}</i>] `;
        // Subagents can produce long output (analysis, code dumps). Split
        // before posting so we don't blow past MAX_MSG_LENGTH.
        const chunks = splitMessage(prefix + text);
        for (const chunk of chunks) {
          if (session.sendHtml) {
            // Strip the plain prefix off the chunk before re-rendering as
            // HTML so we don't double-prefix. First chunk always has it;
            // subsequent chunks start at a wrap point and don't.
            const chunkBody = chunk.startsWith(prefix) ? chunk.slice(prefix.length) : chunk;
            session.sendHtml(chunk, htmlPrefix + markdownToHtml(chunkBody));
          } else if (session.sendCallback) {
            session.sendCallback(chunk);
          }
        }
        session.lastActivityAt = Date.now();
      }
    }

    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      // If a subagent itself spawns another subagent, trigger another
      // discovery burst so the nested agent-<id>.jsonl gets a tail.
      if ((block.name === 'Task' || block.name === 'Agent') && session.subagentWatcher) {
        session.subagentWatcher.notifyTaskStarted();
      }
      const formatted = formatSubagentToolIndicator(label, block.name, block.input || {});
      if (!formatted) continue;
      if (session.sendHtml) {
        session.sendHtml(formatted.plain, formatted.html);
      } else if (session.sendCallback) {
        session.sendCallback(formatted.plain);
      }
      session.lastActivityAt = Date.now();
    }
  }
}

function handleClaudeEvent(session, event) {
  // Capture session ID from any event that carries it.
  if (event.session_id && !session.claudeSessionId) {
    session.claudeSessionId = event.session_id;
    persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId);
    console.log(`Captured session ID for room ${session.roomId}: ${session.claudeSessionId}`);
  }

  // Lazy-construct subagent watcher once we know the session id. Print-mode
  // resumed sessions get the watcher built eagerly in createSession() (since
  // claudeSessionId is already populated at spawn); fresh print-mode
  // sessions only learn their id when the first event with `session_id`
  // arrives, so the watcher is constructed here. iv-mode constructs its
  // watcher up front. Decoupled from the id-capture block above so future
  // refactors can't silently lose the watcher on either spawn path.
  if (session.claudeSessionId && !session.subagentWatcher) {
    session.subagentWatcher = new SubagentWatcher({ workdir: session.workdir, sessionId: session.claudeSessionId, worktreeName: session.worktree });
    session.subagentWatcher.on('subagent-event', payload => handleSubagentEvent(session, payload));
    session.subagentWatcher.snapshot();
  }

  // Log all event types for plan mode debugging
  if (event.type) {
    const extras = [];
    if (event.permission_denials?.length) extras.push(`denials=${JSON.stringify(event.permission_denials)}`);
    if (event.subtype) extras.push(`subtype=${event.subtype}`);
    console.log(`[PLAN-DEBUG] Event type=${event.type}${extras.length ? ' | ' + extras.join(' | ') : ''}`);
  }

  switch (event.type) {
    case 'assistant': {
      // Cancel Enter retry — the turn started successfully
      if (session._enterRetryTimer) {
        clearTimeout(session._enterRetryTimer);
        session._enterRetryTimer = null;
      }
      const content = event.message?.content;
      if (!Array.isArray(content)) break;

      const isPartial = event.message?.stop_reason === null;
      const messageId = event.message?.id;

      const textParts = content.filter(b => b.type === 'text' && b.text).map(b => b.text);
      // Suppress claude's "No response requested." filler. It's emitted in
      // response to internal synthetic prompts (e.g. resume-time nudges)
      // and is just noise on Matrix. Suppress only the text — fall
      // through to the tool_use loop below so any concurrent tool calls
      // (Task/AskUserQuestion/etc.) still get handled.
      const isFiller = textParts.length === 1 && /^\s*No response requested\.?\s*$/.test(textParts[0]);
      if (isFiller) {
        debug('Suppressing "No response requested." filler');
      }

      if (!isFiller && textParts.length > 0) {
        if (isPartial && messageId && session._lastAssistantMsgId === messageId) {
          session.responseBuffer = textParts.join('');
        } else if (!isPartial && messageId && session._lastAssistantMsgId === messageId) {
          session.responseBuffer = textParts.join('');
        } else {
          if (session.responseBuffer.trim() && !session.waitingForAnswer) {
            flushResponse(session);
          }
          session.responseBuffer = session.waitingForAnswer ? '' : textParts.join('');
        }
        session._lastAssistantMsgId = messageId;

        // iv-mode: flush this assistant chunk NOW rather than waiting for
        // /turn-end. Two reasons: (1) the Stop hook races the transcript
        // flush so onTurnEnd is unreliable as a flush trigger; (2) claude
        // emits intermediate commentary with stop_reason=tool_use while
        // chaining tool calls — those messages would otherwise sit in the
        // buffer forever, giving the user a stuck "typing…" indicator and
        // no visible progress. Print-mode keeps its existing accumulate-
        // and-flush-on-result flow.
        if (session.iv && !isPartial && session.responseBuffer.trim() && !session.waitingForAnswer) {
          flushResponse(session);
          // Clear the prompt detector buffer after flushing an assistant
          // response so numbered lists in the response text don't trigger
          // false-positive prompt detections during the post-response idle.
          session.iv.detector.reset();
        }
      }

      for (const block of content) {
        if (block.type !== 'tool_use') continue;

        if (session.responseBuffer.trim() && !session.waitingForAnswer) {
          flushResponse(session);
        }

        const toolName = block.name;
        const input = block.input || {};

        // Ordering fix (PR#3): the MCP ask_user question is registered by POST
        // /ask but surfaced from here so it renders AFTER the explanation text
        // Claude emitted before it (already flushed above, before this loop).
        // Fire the pending surface now, in order. (Reverse ordering — the
        // transcript beating POST /ask — is pathological for a direct HTTP
        // call vs a debounced file tail; that rare case falls back to POST
        // /ask's safety timer, which is still correctly ordered because the
        // preceding text has by then already flushed.)
        if (toolName === 'mcp__ask-user__ask_user'
            && session._pendingQuestionSurface
            && !session._pendingQuestionSurface.surfaced) {
          session._pendingQuestionSurface.surface('trigger');
        }

        if (toolName === 'ExitPlanMode' && !session.iv) {
          // Print-mode only: stash the tool_use_id so a "build" reply can
          // emit the matching tool_result later. iv-mode handles approval
          // through claude's own TUI confirmation prompt instead.
          console.log(`[PLAN-DEBUG] Tool call: ExitPlanMode | block.id: ${block.id} | input keys: ${Object.keys(input).join(',')}`);
          session.pendingPlanDenialId = block.id;
          if (session.claudeSessionId) {
            persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { pendingPlanDenialId: block.id });
          }
        }
        if (toolName === 'EnterPlanMode') {
          console.log(`[PLAN-DEBUG] Tool call: EnterPlanMode | block.id: ${block.id}`);
        }

        if (toolName === 'AskUserQuestion') {
          debug(`AskUserQuestion tool_use block.id=${block.id}, waitingForAnswer=${session.waitingForAnswer}, input keys=${Object.keys(input).join(',')}`);
          if (session.waitingForAnswer) { debug('Skipping AskUserQuestion — already waiting'); continue; }

          const parsed = parseAskUserQuestion(input);
          if (!parsed.questions.length || !parsed.questions[0].question) continue;

          if (session.typingInterval) {
            clearInterval(session.typingInterval);
            session.typingInterval = null;
          }

          session.responseBuffer = '';

          session.waitingForAnswer = 'text-reply';
          session.pendingQuestions = parsed.questions;
          session.currentQuestionIndex = 0;
          session.questionAnswers = [];

          if (session.sendCallback) {
            sendAllQuestions(session);
          }
        } else {
          // Collect tool indicator
          let indicator = `🔧 ${toolName}`;
          let indicatorHtml = null;
          let isKeyEvent = false;
          // Set when sendLiveOutputEvent has been invoked — the live-output
          // message already carries the command in its body/formatted_body
          // fallback, so we skip the duplicate `🔧 <cmd>` indicator below.
          let liveOutputSent = false;

          if (toolName === 'Bash' && input.command) {
            // Claude Code's `tool_use` event reports the ORIGINAL command, not
            // the matron-tee-rewritten one (the rewrite is visible only in the
            // later `system.task_started` event). So we don't try to parse the
            // marker out of input.command — instead we predict the log path
            // deterministically from `block.id`, which matches what the hook
            // writes (`/tmp/matron-cmd-<tool_use_id>.log`). If MATRON_BASH_TEE
            // was disabled at spawn, the file won't exist and the viewer will
            // show its "Output expired" / WS-failed state.
            const displayCommand = input.command;
            const liveToolUseId = block.id;
            const liveLogPath = `/tmp/matron-cmd-${liveToolUseId}.log`;

            const cmd = displayCommand.length > 100
              ? displayCommand.slice(0, 100) + '…'
              : displayCommand;
            indicator = `🔧 \`${cmd}\``;
            indicatorHtml = `🔧 <code>${escapeHtml(cmd)}</code>`;
            isKeyEvent = true;

            if (session.showBashOutput) {
              liveOutputStore.register(liveToolUseId, {
                logPath: liveLogPath,
                roomId: session.roomId,
              });
              const expiresAt = Math.floor(Date.now() / 1000) + LIVE_OUTPUT_TTL;
              if (HMAC_SECRET && VIEWER_BASE_URL) {
                const viewerUrl = generateSignedUrl(
                  VIEWER_BASE_URL,
                  null,
                  HMAC_SECRET,
                  LIVE_OUTPUT_TTL,
                  { liveCmdId: liveToolUseId, logPath: liveLogPath, doneSentinelPath: `${liveLogPath}.done` }
                );
                const liveUrl = new URL(viewerUrl);
                liveUrl.pathname = liveUrl.pathname.replace(/\/view$/, '/live');
                // Optimistically suppress the synchronous indicator post
                // below; if the async send fails we re-post the regular
                // indicator so the user isn't left looking at nothing.
                const fallbackPlain = indicator;
                const fallbackHtml = indicatorHtml;
                sendLiveOutputEvent(session, {
                  tool_use_id: liveToolUseId,
                  command: displayCommand,
                  viewer_url: liveUrl.toString(),
                  expires_at: expiresAt,
                }).then(ok => {
                  if (ok) return;
                  if (session.sendHtml && fallbackHtml) {
                    session.sendHtml(fallbackPlain, fallbackHtml);
                  } else if (session.sendCallback) {
                    session.sendCallback(fallbackPlain);
                  }
                });
                liveOutputSent = true;
              }
            }
          } else if (toolName === 'Read' && input.file_path) {
            indicator = `📖 ${input.file_path}`;
            indicatorHtml = `📖 <code>${escapeHtml(input.file_path)}</code>`;
          } else if (toolName === 'Write' && input.file_path) {
            isKeyEvent = true;
            const absPath = path.isAbsolute(input.file_path)
              ? input.file_path
              : path.join(session.workdir, input.file_path);
            const link = generateFileLink(absPath);
            if (link) {
              indicator = `✏️ Writing [${input.file_path}](${link})`;
              indicatorHtml = `✏️ Writing <a href="${escapeHtml(link)}"><code>${escapeHtml(input.file_path)}</code></a>`;
            } else {
              indicator = `✏️ Writing ${input.file_path}`;
              indicatorHtml = `✏️ Writing <code>${escapeHtml(input.file_path)}</code>`;
            }
          } else if (toolName === 'Edit' && input.file_path) {
            isKeyEvent = true;
            const absPath = path.isAbsolute(input.file_path)
              ? input.file_path
              : path.join(session.workdir, input.file_path);
            const link = generateFileLink(absPath);
            if (link) {
              indicator = `✏️ Editing [${input.file_path}](${link})`;
              indicatorHtml = `✏️ Editing <a href="${escapeHtml(link)}"><code>${escapeHtml(input.file_path)}</code></a>`;
            } else {
              indicator = `✏️ Editing ${input.file_path}`;
              indicatorHtml = `✏️ Editing <code>${escapeHtml(input.file_path)}</code>`;
            }
          } else if ((toolName === 'Glob' || toolName === 'Grep') && input.pattern) {
            indicator = `🔍 ${input.pattern}`;
            indicatorHtml = `🔍 <code>${escapeHtml(input.pattern)}</code>`;
          } else if (toolName === 'WebSearch' && input.query) {
            indicator = `🌐 ${input.query}`;
            indicatorHtml = `🌐 <i>${escapeHtml(input.query)}</i>`;
            isKeyEvent = true;
          } else if (toolName === 'WebFetch' && input.url) {
            indicator = `🌐 ${input.url}`;
            indicatorHtml = `🌐 <a href="${escapeHtml(input.url)}">${escapeHtml(input.url)}</a>`;
          } else if (toolName === 'Task' || toolName === 'Agent') {
            const desc = (input.description || input.prompt || '').slice(0, 80);
            indicator = `🔀 Subtask: ${desc}`;
            indicatorHtml = `🔀 Subtask: <i>${escapeHtml(desc)}</i>`;
            isKeyEvent = true;
            // Trigger the subagent watcher's discovery burst — the new
            // agent-<id>.jsonl file appears within ~100ms of this event.
            if (session.subagentWatcher) {
              session.subagentWatcher.notifyTaskStarted();
            }
          } else if (toolName === 'TodoWrite') {
            const todos = (input.todos || []).map(t => {
              const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬚';
              return `${icon} ${t.content || t.text || ''}`;
            }).join('\n');
            indicator = `📋 Todos:\n${todos}`;
            const todosHtml = (input.todos || []).map(t => {
              const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬚';
              return `<li>${icon} ${escapeHtml(t.content || t.text || '')}</li>`;
            }).join('');
            indicatorHtml = `📋 <b>Todos:</b><ul>${todosHtml}</ul>`;
            isKeyEvent = true;
          }

          // When sendLiveOutputEvent already posted a Matrix message for
          // this Bash call, skip the regular `🔧 <command>` indicator —
          // the live-output message contains the same command in its
          // fallback body/formatted_body, so non-matron-web clients still
          // see it, and matron-web clients see the rendered viewer tile.
          if (!liveOutputSent) {
            session.toolCalls.push(indicator);
            if (isKeyEvent && session.sendHtml && indicatorHtml) {
              session.sendHtml(indicator, indicatorHtml);
            } else if (isKeyEvent && session.sendCallback) {
              session.sendCallback(indicator);
            }
          }
        }
      }
      break;
    }

    case 'result': {
      // Handle fatal errors (e.g. failed resume with invalid session ID)
      // first, regardless of mode — iv-mode resumes can also fail and need
      // the crash-restart loop short-circuited (otherwise the exit handler
      // would retry the same invalid session up to 3 times).
      if (event.is_error && event.errors?.length) {
        const noSession = event.errors.some(e => /no conversation found/i.test(e));
        if (noSession) {
          console.log(`Resume failed for room ${session.roomId}: session not found, clearing stale ID`);
          session.claudeSessionId = null;
          session._resumeFailed = true;
          // Remove stale persisted session so future !resume won't retry it
          const data = loadPersistedSessions();
          delete data[String(session.roomId)];
          savePersistedSessions(data);
          if (session.sendCallback) {
            session.sendCallback('Previous session not found (expired or deleted). Send !start to begin a new session.');
          }
          // Reset busy/typing so the session isn't stuck if claude exits 0
          // without our normal result-handling path running.
          session.busy = false;
          if (session.typingInterval) {
            clearInterval(session.typingInterval);
            session.typingInterval = null;
            client.setTyping(session.roomId, false, 1000).catch(() => {});
          }
          break;
        }
      }
      // Past the error path: in iv-mode `onTurnEnd` is the authoritative
      // turn-end signal (fired by the Stop hook → /turn-end → onTurnEnd).
      // iv-mode transcripts don't emit result events in normal operation;
      // if one slips through it would double-count turnCount, re-flush
      // responseBuffer, re-post tool summaries, re-clear busy/typing, and
      // re-drain queued messages on top of what onTurnEnd already did.
      if (session.iv) {
        debug('Result event arrived for iv-mode session past error path — onTurnEnd handles turn-end; skipping duplicate work.');
        break;
      }

      // Accumulate usage stats
      session.turnCount++;
      const u = event.usage;
      if (u) {
        session.totalUsage.input_tokens += (u.input_tokens || 0);
        session.totalUsage.output_tokens += (u.output_tokens || 0);
        session.totalUsage.cache_read += (u.cache_read_input_tokens || 0);
        session.totalUsage.cache_create += (u.cache_creation_input_tokens || 0);
      }
      if (typeof event.total_cost_usd === 'number') {
        session.totalUsage.cost_usd = event.total_cost_usd;
      }

      // Send collected tool calls as one message before the result (only if showWorking)
      if (session.toolCalls.length > 0 && session.showWorking && session.sendCallback) {
        const toolSummary = session.toolCalls.join('\n');
        const chunks = splitMessage(toolSummary);
        for (const chunk of chunks) {
          session.sendCallback(chunk);
        }
      }
      session.toolCalls = [];

      if (!session.waitingForAnswer) {
        const text = extractTextContent(event);
        if (text) {
          session.responseBuffer = text;
        }
        flushResponse(session);
      } else {
        session.responseBuffer = '';
      }
      session.busy = false;
      stripQueueNotificationLinks(session);
      if (session.typingInterval) {
        clearInterval(session.typingInterval);
        session.typingInterval = null;
        client.setTyping(session.roomId, false, 1000).catch(() => {});
      }

      // Check for ExitPlanMode permission denial — present Build prompt
      const denials = event.permission_denials || [];
      console.log(`[PLAN-DEBUG] Room ${session.roomId} | result event | denials: ${JSON.stringify(denials)} | pendingPlan: ${!!session.pendingPlan}`);
      const planDenial = denials.find(d => d.tool_name === 'ExitPlanMode');
      if (planDenial && session.sendCallback) {
        console.log(`[PLAN-DEBUG] ExitPlanMode denial found! tool_use_id: ${planDenial.tool_use_id} | plan length: ${(planDenial.tool_input?.plan || '').length}`);
        const planText = planDenial.tool_input?.plan || '';
        session.pendingPlan = planText;
        session.pendingPlanDenialId = planDenial.tool_use_id;

        const planPreview = planText.length > 500
          ? planText.slice(0, 500) + '…'
          : planText;

        const plainPlan = `--- Plan Ready ---\n\n${planPreview}\n\nReply "build" to execute, or send feedback.`;
        if (session.sendHtml) {
          const htmlPlan =
            `<b>📋 Plan Ready</b><blockquote>${markdownToHtml(planPreview)}</blockquote>` +
            `Reply <code>build</code> to execute, or send feedback.`;
          session.sendHtml(plainPlan, htmlPlan);
        } else {
          session.sendCallback(plainPlan);
        }
      }

      // Send any queued messages now that Claude is free
      if (session.queuedMessages && session.queuedMessages.length > 0 && !session.waitingForAnswer) {
        const queued = session.queuedMessages;
        session.queuedMessages = null;
        if (session.sendHtml) {
          const summary = formatQueueSummary(queued);
          const plainMsg = `📬 Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''}:\n${summary.plain}`;
          const htmlMsg = `<b>📬 Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''}:</b>${summary.html}`;
          session.sendHtml(plainMsg, htmlMsg);
        } else if (session.sendCallback) {
          const summary = formatQueueSummary(queued);
          session.sendCallback(`📬 Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''}:\n${summary.plain}`);
        }
        flushQueue(session, queued);
      }

      break;
    }

    case 'system': {
      if (event.subtype === 'init') {
        session.initData = event;
        debug('Captured init data: model=%s, tools=%d, mcp=%d',
          event.model, event.tools?.length, event.mcp_servers?.length);
      } else if (event.subtype === 'compact' || event.subtype === 'context_compaction') {
        // Cooldown: don't send compaction messages more than once per 60s
        const now = Date.now();
        const COMPACT_COOLDOWN_MS = 60_000;
        if (!session.lastCompactCompleteNotify || (now - session.lastCompactCompleteNotify) > COMPACT_COOLDOWN_MS) {
          session.lastCompactCompleteNotify = now;
          if (session.sendHtml) {
            const n = notice('info', '🗜️ Context compacted — conversation history was summarized to free up space');
            session.sendHtml(n.plain, n.html);
          } else if (session.sendCallback) {
            session.sendCallback('🗜️ Context compacted — conversation history was summarized to free up space');
          }
        } else {
          debug('Suppressed compaction completion notice (cooldown, last=%dms ago)', now - session.lastCompactCompleteNotify);
        }
      } else if (event.subtype === 'task_notification') {
        const isComplete = event.status === 'completed';
        const taskPlain = `${isComplete ? '✅' : '❌'} Task: ${event.summary || 'unknown'}`;
        if (session.sendHtml) {
          const n = notice(isComplete ? 'success' : 'error', taskPlain);
          session.sendHtml(n.plain, n.html);
        } else if (session.sendCallback) {
          session.sendCallback(taskPlain);
        }
      } else if (event.subtype === 'compact_boundary') {
        // A manual `/compact` finishes here: the transcript writes a
        // compact_boundary marker but — unlike a normal turn — no Stop hook
        // fires, so onTurnEnd (the authoritative iv turn-end signal) never
        // runs and `busy` stays stuck true, wedging every later message into
        // the queue. When we know the operator kicked off this compaction
        // (flag set at /compact dispatch) and the boundary confirms a manual
        // trigger, treat it as the turn-end: clear busy and flush the queue
        // via onTurnEnd. Auto-compactions (trigger='auto') happen mid-turn
        // and MUST NOT clear busy here — their real Stop hook fires when the
        // interrupted turn completes.
        const trigger = event.compactMetadata?.trigger;
        if (session._operatorCompactPending && trigger === 'manual') {
          session._operatorCompactPending = false;
          if (session._operatorCompactTimer) {
            clearTimeout(session._operatorCompactTimer);
            session._operatorCompactTimer = null;
          }
          if (session.sendHtml) {
            const n = notice('success', '✅ Done compacting — context summarized, ready for your next message.');
            session.sendHtml(n.plain, n.html);
          } else if (session.sendCallback) {
            session.sendCallback('✅ Done compacting — context summarized, ready for your next message.');
          }
          // onTurnEnd clears busy + typing and flushes any queued messages.
          // Print-mode sessions have no onTurnEnd (no PTY); clear busy directly.
          if (session.iv && typeof session.onTurnEnd === 'function') {
            session.onTurnEnd();
          } else {
            session.busy = false;
          }
        }
      }
      break;
    }

    case 'stream_event': {
      // Note: context_management.applied_edits in message_delta events fire on
      // routine context trimming (every turn in long sessions), NOT just full
      // compaction. The system event with subtype='compact' already handles
      // actual compaction notifications, so we intentionally skip these here
      // to avoid spamming the Matrix room.
      break;
    }

    case 'user': {
      const userContent = event.message?.content;
      if (Array.isArray(userContent)) {
        for (const block of userContent) {
          // Mark live-output complete on tool_result for any tracked Bash command.
          if (block.type === 'tool_result' && block.tool_use_id) {
            const entry = liveOutputStore.get(block.tool_use_id);
            if (entry) {
              const blockText = typeof block.content === 'string'
                ? block.content
                : (Array.isArray(block.content)
                    ? block.content.filter(c => c && c.type === 'text').map(c => c.text || '').join('')
                    : '');
              const denied = /permission/i.test(blockText);
              const truncated = blockText.includes('[matron-tee: output truncated');
              const ecMatch = blockText.match(/exit code[: ]+(\d+)/i);
              const exitCode = ecMatch ? parseInt(ecMatch[1], 10) : (block.is_error ? 1 : 0);
              liveOutputStore.markComplete(block.tool_use_id, { exitCode, denied, truncated });
            }
          }
          if (block.type === 'tool_result' && block.is_error) {
            debug(`Auto tool_result: tool_use_id=${block.tool_use_id}, content=${JSON.stringify(block.content).slice(0, 100)}`);
          }
        }
      }
      break;
    }

    default:
      break;
  }
}

// --- Text Helpers ---

function extractTextContent(event) {
  if (event.type === 'result' && typeof event.result === 'string') {
    return event.result;
  }

  const content = event.message?.content || event.content;
  if (!content) return '';

  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
  }

  return '';
}

function flushResponse(session) {
  const text = session.responseBuffer.trim();
  session.responseBuffer = '';

  if (!text) return;

  // Track assistant response for topic summarization (strip code blocks)
  const cleanText = text.replace(/```[\s\S]*?```/g, '').trim();
  if (cleanText) {
    if (!session.chatHistory) session.chatHistory = [];
    session.chatHistory.push({ role: 'assistant', text: cleanText });
    debug(`Added assistant message to chatHistory, length now: ${session.chatHistory.length}`);
    // Persist chatHistory for resume across restarts
    if (session.claudeSessionId) {
      persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { chatHistory: session.chatHistory });
    }
    // Update room name and pinned summary after adding message
    maybeUpdatePinnedSummary(session);
  }

  if (session.sendCallback) {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      session.sendCallback(chunk);
    }
  }
  // Bump idle clock whenever we have assistant text to flush, regardless
  // of whether a callback is wired. The guard above is about output
  // delivery; the activity timestamp is about session liveness.
  session.lastActivityAt = Date.now();
}

// [QUEUE-PROBE] Read-only instrumentation (separate from the compact fix).
// Reports Claude's REAL TUI state at a given instant, independent of the
// bridge's `busy` guess. We use it to detect two things:
//   • BUSY-CLEAR while Claude is still generating → the bridge opened a window
//     where the operator's next message bypasses the bridge queue.
//   • SEND while Claude is still generating → that message was typed into the
//     PTY mid-turn and lands in Claude Code's OWN internal queue (the
//     "server-side queue" that replays as a surprise follow-up), not held
//     bridge-side. `isIdleReadyScreen` keys off the TUI "esc to interrupt"
//     hint, which is only present while a turn/compaction runs.
// Remove once the leak is characterised.
function probePtyState(session) {
  try {
    const buf = session.iv?.detector?.buf || '';
    const compact = buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').toLowerCase().replace(/\s+/g, '');
    return {
      idleReady: isIdleReadyScreen(buf),
      working: compact.includes('esctointerrupt'),
      bufLen: buf.length,
    };
  } catch (e) {
    return { idleReady: null, working: null, bufLen: 0, err: e?.message };
  }
}

function clearBusyAfterEsc(session) {
  session.busy = false;
  if (session.typingInterval) {
    clearInterval(session.typingInterval);
    session.typingInterval = null;
    client.setTyping(session.roomId, false, 1000).catch(() => {});
  }
  // Safety net: Esc-cancelled turns don't fire the Stop hook, so onTurnEnd
  // never runs. If something re-sets busy during the cancellation wind-down
  // (e.g. a late transcript event processed between now and the TUI returning
  // to the input prompt), re-clear after a delay. The 2s window covers the
  // typical Esc → input-prompt transition.
  if (session._escBusyTimer) clearTimeout(session._escBusyTimer);
  session._escBusyTimer = setTimeout(() => {
    session._escBusyTimer = null;
    if (session.busy && session.alive) {
      debug('[ESC] Safety timer: re-clearing busy after Esc cancellation');
      session.busy = false;
      if (session.typingInterval) {
        clearInterval(session.typingInterval);
        session.typingInterval = null;
        client.setTyping(session.roomId, false, 1000).catch(() => {});
      }
    }
  }, 2000);
}

function sendToSession(session, contentBlocks) {
  if (!session.alive || session._autoStopped) return false;

  // Resume-hold gate: while a just-resumed iv session isn't input-ready yet,
  // buffer outgoing messages instead of typing them into the still-loading
  // TUI. The readiness watcher (startResumeReadyWatcher) flushes them, merged
  // and in order, once claude is idle. See RESUME_READY_* above.
  if (session._awaitingInputReady) {
    (session._resumeOutbox ||= []).push(contentBlocks);
    session.lastActivityAt = Date.now();
    return true;
  }

  session.lastActivityAt = Date.now();
  session.responseBuffer = '';
  session.toolCalls = [];
  session.busy = true;

  if (session.typingInterval) clearInterval(session.typingInterval);
  session.typingInterval = startTyping(session.roomId);

  if (session.iv) {
    // Interactive mode: type text blocks into the PTY. Non-text content
    // (images, encoded attachments) is not currently supportable via PTY
    // input — log and drop. Phase 6 (post-cutover) will add image handling
    // via a separate channel (probably writing the image bytes to a tmp
    // path and typing a /file reference).
    const nonText = contentBlocks.filter(b => b.type !== 'text');
    if (nonText.length > 0) {
      debug(`iv-mode: dropping ${nonText.length} non-text block(s): ${nonText.map(b => b.type).join(',')}`);
    }
    const text = contentBlocks.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
    if (text) {
      // Gate on TUI readiness: the PTY swallows Enter keystrokes during
      // the resume/init window (before the toolbar renders). Stash the
      // content blocks and let markIvReady() call sendToSession() once
      // the TUI is actually ready to accept input.
      if (!session.ivReady) {
        debug('[IV] TUI not ready — stashing input for deferred send');
        session.ivPendingInput = contentBlocks;
        if (session.resetTimeout) session.resetTimeout();
        return true;
      }
      // [QUEUE-PROBE] Snapshot Claude's real TUI state right before we type.
      // idleReady=false + working=true here means we wrote mid-turn and the
      // text landed in Claude Code's internal queue, not held bridge-side.
      const __q = probePtyState(session);
      console.log(`[QUEUE-PROBE] SEND room=${session.roomId.slice(1, 7)} idleReady=${__q.idleReady} working=${__q.working} busy=${session.busy} waiting=${!!session.waitingForAnswer} queued=${session.queuedMessages?.length || 0} bufLen=${__q.bufLen} text="${text.slice(0, 48).replace(/\n/g, ' ')}"`);
      // Propagate a dead-PTY write failure: iv.sendText returns false when the
      // PTY has exited (lib/interactive-session.js). Surfacing false lets callers
      // (incl. the auto-prompt path's delivery check) detect a lost write instead
      // of falsely reporting success.
      if (session.iv.sendText(text) === false) return false;
      // Enter retry: after sending text, the 500ms delayed Enter may be
      // swallowed if the TUI has a transient hiccup. Watch for transcript
      // activity — if none arrives within 3s, retry Enter. Up to 2 retries.
      let retries = 0;
      const maxRetries = 2;
      const retryMs = 3000;
      function scheduleRetry() {
        if (retries >= maxRetries) return;
        session._enterRetryTimer = setTimeout(() => {
          session._enterRetryTimer = null;
          if (!session.alive || !session.iv?.alive) return;
          if (!session.busy) return;
          if (session.responseBuffer.trim()) return;
          retries++;
          debug(`[IV] Enter retry ${retries}/${maxRetries} — no response after ${retryMs}ms`);
          session.iv.sendKeystroke('enter');
          scheduleRetry();
        }, retryMs);
        if (typeof session._enterRetryTimer.unref === 'function') session._enterRetryTimer.unref();
      }
      scheduleRetry();
      if (session.resetTimeout) session.resetTimeout();
      return true;
    }
    // Nothing to send (all blocks were non-text and got dropped). Don't
    // leave the session in `busy=true` with a stuck typing indicator —
    // no claude turn means no Stop hook to clear them.
    session.busy = false;
    if (session.typingInterval) {
      clearInterval(session.typingInterval);
      session.typingInterval = null;
      client.setTyping(session.roomId, false, 1000).catch(() => {});
    }
    // Tell the user what happened directly. Returning true so the caller's
    // generic "Session is not available" fallback doesn't fire — the
    // session IS alive, we just can't forward non-text content through the
    // PTY yet (Phase 6 will add image handling via a side channel).
    const msg = `Can't send ${nonText.length} non-text attachment(s) in interactive mode yet — PTY input is text-only. Send a text message or switch the session out of iv-mode.`;
    if (session.sendHtml) session.sendHtml(msg, escapeHtml(msg));
    else if (session.sendCallback) session.sendCallback(msg);
    return true;
  }

  const jsonMsg = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: contentBlocks
    }
  }) + '\n';
  debug('Sending to stdin:', jsonMsg.length > 1000
    ? jsonMsg.slice(0, 500) + `... [${jsonMsg.length} chars total]`
    : jsonMsg.trim());
  session.proc.stdin.write(jsonMsg);
  if (session.resetTimeout) session.resetTimeout();
  return true;
}

function sendTextToSession(session, text) {
  return sendToSession(session, [{ type: 'text', text }]);
}

// Begin holding outgoing messages for a freshly-resumed iv session and start
// watching for the moment claude is idle-and-ready to receive them. Called
// from the auto-resume branch right after the PTY is spawned. No-op for
// non-iv sessions (print mode feeds stdin JSON, which claude buffers fine).
function enterResumeHold(session) {
  if (!session.iv) return;
  session._awaitingInputReady = true;
  session._resumeOutbox = [];
  // No typing indicator here: a resume may surface the "Resume from summary"
  // picker, and showing "Claude is typing…" while we're actually asking the
  // user a question reads wrong. The "Auto-resuming…" notice already conveys
  // what's happening; the real send (on flush) starts typing normally.
  startResumeReadyWatcher(session);
}

// Watch a resuming iv session's PTY output; once it goes quiet AND the screen
// shows the idle input box, flush any held messages (merged, in order) via the
// normal send path. A hard cap guarantees the held message is eventually sent
// even if readiness is never cleanly detected — but it defers while a TUI
// prompt (e.g. the resume-summary picker) is awaiting the user's answer, so
// the held message is never typed into a menu.
function startResumeReadyWatcher(session) {
  const iv = session.iv;
  if (!iv) return;
  let buf = '';
  let quietTimer = null;
  let hardCap = null;
  let settled = false;

  const finish = (reason) => {
    if (settled) return;
    settled = true;
    if (quietTimer) clearTimeout(quietTimer);
    if (hardCap) clearTimeout(hardCap);
    iv.removeListener('pty-data', onData);
    session._awaitingInputReady = false;
    const outbox = session._resumeOutbox || [];
    session._resumeOutbox = null;
    debug(`iv resume-ready (${reason}); flushing ${outbox.length} held message(s)`);
    if (session.alive && outbox.length > 0) {
      // Merge everything the user sent during the hold into a single turn.
      // The gate is now disarmed, so this reaches the real send path.
      sendToSession(session, outbox.flat());
    } else {
      // Nothing to send (or session died) — don't leave a typing indicator
      // spinning with no turn behind it.
      session.busy = false;
      if (session.typingInterval) {
        clearInterval(session.typingInterval);
        session.typingInterval = null;
        client.setTyping(session.roomId, false, 1000).catch(() => {});
      }
    }
  };

  const evaluate = () => {
    if (settled || !session.alive) return finish('dead');
    // A surfaced TUI prompt (e.g. the resume-summary picker) means claude
    // wants a structured answer, not a free message — let the prompt flow
    // handle it and keep holding; the user's answer produces more PTY data
    // that re-arms this check.
    if (session.pendingInteractivePrompt) return;
    if (isIdleReadyScreen(buf)) finish('idle');
  };

  const onData = (data) => {
    buf += data;
    if (buf.length > 32768) buf = buf.slice(-32768);
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(evaluate, RESUME_READY_QUIET_MS);
  };

  const onHardCap = () => {
    if (settled) return;
    // If the user still hasn't answered a surfaced prompt, don't dump the
    // held message into it — give them another window.
    if (session.pendingInteractivePrompt) {
      hardCap = setTimeout(onHardCap, RESUME_READY_HARDCAP_MS);
      if (typeof hardCap.unref === 'function') hardCap.unref();
      return;
    }
    finish('timeout');
  };

  hardCap = setTimeout(onHardCap, RESUME_READY_HARDCAP_MS);
  if (typeof hardCap.unref === 'function') hardCap.unref();
  iv.on('pty-data', onData);
}

function formatQueueSummary(queued) {
  const lines = [];
  for (let i = 0; i < queued.length; i++) {
    const blocks = queued[i];
    const isTextOnly = blocks.every(b => b.type === 'text');
    if (isTextOnly) {
      const text = blocks.map(b => b.text).join('\n');
      const preview = text.length > 200 ? text.slice(0, 197) + '…' : text;
      lines.push({ index: i + 1, text: preview });
    } else {
      const types = blocks.filter(b => b.type !== 'text').map(b => b.type === 'image' ? 'image' : b.type === 'audio' ? 'audio' : 'file');
      lines.push({ index: i + 1, text: `[${types.join(', ')}]` });
    }
  }
  const plain = lines.map(l => `  ${l.index}. ${l.text}`).join('\n');
  const html = lines.map(l =>
    `<li>${escapeHtml(l.text)}</li>`
  ).join('');
  return { plain, html: `<ol>${html}</ol>` };
}

function flushQueue(session, queued) {
  const merged = [];
  let textAccum = [];

  function flushText() {
    if (textAccum.length === 0) return;
    const combined = textAccum.map(blocks =>
      blocks.map(b => b.text).join('\n')
    ).join('\n\n');
    merged.push({ type: 'text', text: combined });
    textAccum = [];
  }

  for (const blocks of queued) {
    const isTextOnly = blocks.every(b => b.type === 'text');
    if (isTextOnly) {
      textAccum.push(blocks);
    } else {
      flushText();
      merged.push(...blocks);
    }
  }
  flushText();

  if (merged.length > 0) {
    if (!sendToSession(session, merged)) {
      console.log(`[QUEUE] dropped ${queued.length} queued message(s) — session dead or auto-stopped (room ${session.roomId})`);
    }
  }
}

function splitMessage(text) {
  if (text.length <= MAX_MSG_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', MAX_MSG_LENGTH);
    if (splitAt < MAX_MSG_LENGTH * 0.5) {
      splitAt = remaining.lastIndexOf(' ', MAX_MSG_LENGTH);
    }
    if (splitAt < MAX_MSG_LENGTH * 0.5) {
      splitAt = MAX_MSG_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// --- Auth helper ---

function isAllowed(userId) {
  if (ALLOWED_USER_IDS.length === 0) return true;
  return ALLOWED_USER_IDS.includes(String(userId));
}

// Track senders we've already warned about so a chatty disallowed user
// doesn't flood the log, but a misconfigured allowlist still screams once
// per restart per offender. Without this, ALLOWED_USER_IDS mismatches
// (e.g. dbarker on Matrix vs danbarker on the VPS) look exactly like
// "the bridge is dead" — bridge runs, sync runs, messages are decrypted,
// then silently dropped. The previous behaviour cost about an hour of
// debugging on the first external-mode box.
const warnedDisallowedSenders = new Set();
function warnIfDisallowed(sender, roomId) {
  if (isAllowed(sender)) return false;
  if (!warnedDisallowedSenders.has(sender)) {
    warnedDisallowedSenders.add(sender);
    console.warn(
      `[allowlist] Dropping message from ${sender} in ${roomId} — ` +
      `not in ALLOWED_USER_IDS (${ALLOWED_USER_IDS.join(', ') || '(empty — set to reject all)'}). ` +
      `If this is you, fix ALLOWED_USER_IDS in .env (your full Matrix ID, e.g. @you:server) and restart the bridge. ` +
      `Suppressing further warnings from this sender until restart.`
    );
  }
  return true;
}

// --- Markdown to HTML ---

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function color(text, hex) {
  return `<font color="${hex}">${text}</font>`;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

const NOTICE_COLORS = {
  success: '#3fb950',
  error: '#f85149',
  warning: '#f0883e',
  info: '#58a6ff',
};

function notice(type, plainText, htmlContent) {
  const hex = NOTICE_COLORS[type] || NOTICE_COLORS.info;
  return {
    plain: plainText,
    html: `${color('▌', hex)} ${htmlContent || escapeHtml(plainText)}`,
  };
}

function markdownToHtml(text) {
  let processed = text.replace(/\*\*`([^`\n]+)`\*\*/g, '‹b›‹code›$1‹/code›‹/b›');

  // Convert list markers to placeholders BEFORE backtick split so inline code in list items works
  processed = processed.replace(/^([-*])\s+/gm, '‹li›');
  processed = processed.replace(/^(\d+)\.\s+/gm, '‹li›');

  const parts = processed.split(/(```[\s\S]*?```|`[^`\n]+`)/g);

  // Phase 1: Process each part (inline formatting for text, code wrapping for code)
  let html = parts.map((part, i) => {
    if (i % 2 === 1) {
      if (part.startsWith('```')) {
        const inner = part.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
        const lineCount = inner.split('\n').length;
        if (lineCount > 15) {
          return `<details><summary>Code (${lineCount} lines)</summary><pre><code>${escapeHtml(inner)}</code></pre></details>`;
        }
        return `<pre><code>${escapeHtml(inner)}</code></pre>`;
      }
      return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    }

    let html = escapeHtml(part);

    html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    html = html.replace(/__(.+?)__/g, '<b>$1</b>');
    html = html.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>');
    html = html.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<i>$1</i>');
    html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

    // Markdown links: [text](url)
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');

    // Linkify remaining bare URLs (not already inside tags)
    html = html.replace(/(?<!href="|">)(https?:\/\/[^\s<>"']+)/g, '<a href="$1">$1</a>');

    // Horizontal rules
    html = html.replace(/^-{3,}$/gm, '<hr/>');

    // Blockquotes: consecutive > lines
    html = html.replace(/(^&gt;\s?.+(\n|$))+/gm, (match) => {
      const inner = match.replace(/^&gt;\s?/gm, '').trim();
      return `<blockquote>${inner}</blockquote>`;
    });

    return html;
  }).join('');

  // Phase 2: Block-level processing on joined HTML (so inline code within lists/tables works)
  html = html.replace(/‹b›‹code›/g, '<b><code>');
  html = html.replace(/‹\/code›‹\/b›/g, '</code></b>');

  // List items (markers were converted to ‹li› before backtick split)
  html = html.replace(/^‹li›(.+)$/gm, '<li>$1</li>');

  // Tables: consecutive lines starting with | — render as <pre><code> for cross-client compatibility
  html = html.replace(/(?:^|\n)((?:\|[^\n]+\|\n?)+)/g, (match, tableBlock) => {
    return '<pre><code>' + padTable(tableBlock).replace(/\n/g, '&#10;') + '</code></pre>';
  });

  // Wrap consecutive <li> in <ul>
  html = html.replace(/(<li>[\s\S]*?<\/li>)(\n<li>[\s\S]*?<\/li>)*/g, (match) => {
    return `<ul>${match}</ul>`;
  });

  // Protect newlines inside <pre> blocks before converting to <br/>
  html = html.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (match, inner) => {
    return '<pre><code>' + inner.replace(/\n/g, '&#10;') + '</code></pre>';
  });
  html = html.replace(/<pre>([\s\S]*?)<\/pre>/g, (match, inner) => {
    return '<pre>' + inner.replace(/\n/g, '&#10;') + '</pre>';
  });

  // Convert newlines to <br/> (but not before/after block elements)
  html = html.replace(/\n/g, '<br/>');

  // Restore newlines in <pre> blocks
  html = html.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (match, inner) => {
    return '<pre><code>' + inner.replace(/&#10;/g, '\n') + '</code></pre>';
  });
  html = html.replace(/<pre>([\s\S]*?)<\/pre>/g, (match, inner) => {
    return '<pre>' + inner.replace(/&#10;/g, '\n') + '</pre>';
  });

  // Clean up excessive <br/> around block elements
  html = html.replace(/<br\/>(<\/?(?:hr|li|pre|ol|ul|table|thead|tbody|tr|th|td|blockquote|details|summary)(?:\s[^>]*)?>)/g, '$1');
  html = html.replace(/(<\/?(?:hr|li|pre|ol|ul|table|thead|tbody|tr|th|td|blockquote|details|summary)(?:\s[^>]*)?>)<br\/>/g, '$1');

  return html;
}

// Pad pipe table columns to equal widths
function padTable(tableText) {
  const rows = tableText.trim().split('\n');
  const parsed = rows.map(r => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
  const colCount = Math.max(...parsed.map(r => r.length));
  const widths = Array(colCount).fill(0);
  for (const row of parsed) {
    // Skip separator rows for width calculation
    if (/^[\s\-:]+$/.test(row.join(''))) continue;
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i], (row[i] || '').length);
    }
  }
  return rows.map(r => {
    const cells = r.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (/^[\s\-:]+$/.test(cells.join(''))) {
      return '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';
    }
    return '| ' + cells.map((c, i) => (c || '').padEnd(widths[i] || 0)).join(' | ') + ' |';
  }).join('\n');
}

// Improve plain text body for clients that don't render HTML (e.g. Element X)
// Wraps pipe tables in code fences so they render monospaced with aligned columns
function plainTextFormat(text) {
  return text.replace(/((?:^\|.+\|\n?)+)/gm, (match) => {
    return '```\n' + padTable(match) + '\n```';
  });
}

// --- File Helpers ---

function sessionEffectiveCwd(session) {
  if (session.worktree) {
    const wtPath = path.join(session.workdir, '.claude', 'worktrees', session.worktree);
    if (fs.existsSync(wtPath)) return wtPath;
    throw new Error(`Worktree directory not found: ${wtPath}`);
  }
  return session.workdir;
}

function uploadsDir(session) {
  const base = sessionEffectiveCwd(session);
  const dir = path.join(base, 'uploads');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function deduplicateFilename(dir, filename) {
  let target = path.join(dir, filename);
  if (!fs.existsSync(target)) return target;

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let i = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${base}-${i}${ext}`);
    i++;
  }
  return target;
}

// --- Matrix Typing Indicator ---

function startTyping(roomId) {
  const send = () => client.setTyping(roomId, true, 30000).catch(() => {});
  send();
  // Refresh every 25s (Matrix typing expires after timeout)
  return setInterval(send, 25000);
}

function readSidecarToken() {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.claude-matrix-bot-crypto', 'access-token'), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

// --- Matrix Client ---

const CRYPTO_DIR = path.join(os.homedir(), '.claude-matrix-bot-crypto');
const TOKEN_SIDECAR = path.join(CRYPTO_DIR, 'access-token');

// Resolve the access token. Sidecar (written by first-start bootstrap)
// takes precedence over MATRIX_ACCESS_TOKEN from .env, so re-renders
// of .env (e.g. dev-boxer setup re-runs) can't overwrite a token the
// bridge minted itself.
let resolvedAccessToken = readSidecarToken() || MATRIX_ACCESS_TOKEN;

if (!resolvedAccessToken && process.env.MATRIX_BOT_USER_ID && process.env.MATRIX_BOT_PASSWORD && process.env.MATRIX_BOT_RECOVERY_KEY) {
  console.log('First-start bootstrap: minting access token from imported bot creds');
  const out = execFileSync(process.execPath, [path.join(__dirname, 'bootstrap-from-creds.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  }).toString();
  const match = out.match(/^access_token=(.+)$/m);
  if (!match) {
    console.error('Bootstrap did not return an access token. Output was:\n' + out);
    process.exit(1);
  }
  resolvedAccessToken = match[1].trim();
  fs.mkdirSync(CRYPTO_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_SIDECAR, resolvedAccessToken, { mode: 0o600 });
}

if (!resolvedAccessToken) {
  console.error('MATRIX_ACCESS_TOKEN is required (set directly, or supply MATRIX_BOT_USER_ID + MATRIX_BOT_PASSWORD + MATRIX_BOT_RECOVERY_KEY for first-start bootstrap)');
  process.exit(1);
}

const storage = new SimpleFsStorageProvider(path.join(os.homedir(), '.claude-matrix-bot-state.json'));
const cryptoStorage = new RustSdkCryptoStorageProvider(CRYPTO_DIR);
const client = new MatrixClient(MATRIX_HOMESERVER_URL, resolvedAccessToken, storage, cryptoStorage);
AutojoinRoomsMixin.setupOnClient(client);

let botUserId;

// --- Send to Matrix Room ---

async function sendToRoom(roomId, text, html) {
  const content = {
    msgtype: 'm.text',
    body: text,
  };
  if (html) {
    content.format = 'org.matrix.custom.html';
    content.formatted_body = html;
  }
  try {
    const eventId = await client.sendMessage(roomId, content);
    return eventId || null;
  } catch (e) {
    console.error('Failed to send message:', e.message);
    return null;
  }
}

async function sendLiveOutputEvent(session, { tool_use_id, command, viewer_url, expires_at }) {
  // Sent as a regular m.room.message with a custom content key:
  // - matron-web-aware clients pick up `chat.matron.live_output` and render
  //   the live viewer tile.
  // - Every other Matrix client just shows the body/formatted_body which
  //   already contains the command and a link to view live output. That
  //   makes the regular `🔧 <command>` indicator redundant, so the caller
  //   in the assistant-event handler skips it when this event is sent.
  // Match the truncation/icon style of the regular `🔧 <cmd>` indicator so
  // clients that can't render the custom event (most mobile clients) still
  // get a tight, readable fallback instead of a full untruncated command
  // and a viewer URL they can't follow.
  const truncated = command.length > 100 ? command.slice(0, 100) + '…' : command;
  const body = `🔧 \`${truncated}\``;
  const formatted_body = `🔧 <a href="${escapeHtml(viewer_url)}"><code>${escapeHtml(truncated)}</code></a>`;
  const content = {
    msgtype: 'm.text',
    body,
    format: 'org.matrix.custom.html',
    formatted_body,
    [`${MATRIX_EVENT_NAMESPACE}.live_output`]: { tool_use_id, command, viewer_url, expires_at },
  };
  try {
    await client.sendMessage(session.roomId, content);
    return true;
  } catch (e) {
    console.error('Failed to send live_output event:', e.message);
    return false;
  }
}

async function sendButtonMessage(roomId, prompt, buttons, mode, fallbackBody, fallbackHtml) {
  console.log(`[BUTTONS] Sending button message: mode=${mode}, buttons=${buttons.length}, prompt=${prompt.substring(0, 50)}`);
  const content = {
    msgtype: 'm.text',
    body: fallbackBody,
    format: 'org.matrix.custom.html',
    formatted_body: fallbackHtml,
    [`${MATRIX_EVENT_NAMESPACE}.buttons`]: {
      mode,       // 'pick_one' or 'pick_many'
      prompt,
      buttons,    // [{ id, label, value }]
    },
  };
  try {
    const eventId = await client.sendMessage(roomId, content);
    return eventId || null;
  } catch (e) {
    console.error('Failed to send button message:', e.message);
    return null;
  }
}

// --- Room Management ---

const MATRON_COMMANDS = [
  { command: 'start', args: '[workdir]', description: 'Start a new session' },
  { command: 'stop', description: 'Stop the current session' },
  { command: 'restart', description: 'Stop and immediately resume' },
  { command: 'resume', args: '<n|id>', description: 'Resume a past session' },
  { command: 'sessions', description: 'List past sessions' },
  { command: 'workdir', args: '<path>', description: 'Start in a specific directory' },
  { command: 'status', description: 'Show session info' },
  { command: 'working', description: 'Toggle tool call visibility' },
  { command: 'mcp', description: 'Show MCP server status' },
  { command: 'model', description: 'Show current model' },
  { command: 'cost', description: 'Show session cost' },
  { command: 'usage', description: 'Show token usage' },
  { command: 'tools', description: 'List available tools' },
  { command: 'label', description: 'Show or set server label for room names' },
  { command: 'help', description: 'Show all commands' },
];

async function createSessionRoom(inviteUserId) {
  const initialState = [
    ...(ENCRYPT_SESSION_ROOMS ? [{
      type: 'm.room.encryption',
      state_key: '',
      content: { algorithm: 'm.megolm.v1.aes-sha2' },
    }] : []),
    ...COMMAND_EVENT_TYPES.map(type => ({
      type,
      state_key: '',
      content: { commands: MATRON_COMMANDS },
    })),
  ];

  const userPL = getUserRole(inviteUserId) === 'admin' ? 50 : 0;
  const roomId = await client.createRoom({
    preset: 'private_chat',
    name: `${SERVER_LABEL}: New session`,
    invite: [inviteUserId],
    initial_state: initialState,
    power_level_content_override: {
      users: {
        [await client.getUserId()]: 100,
        [inviteUserId]: userPL,
      },
      invite: 100,
      kick: 100,
      ban: 100,
      redact: 100,
      state_default: 100,
      events: {
        'm.room.name': 50,
        'm.room.topic': 50,
      },
    },
  });
  debug(`Created session room ${roomId} for ${inviteUserId} (role=${getUserRole(inviteUserId)}, PL=${userPL})`);
  return roomId;
}

async function editMessage(roomId, eventId, plain, html) {
  const content = {
    msgtype: 'm.text',
    body: `* ${plain}`,
    'm.new_content': {
      msgtype: 'm.text',
      body: plain,
      ...(html ? { format: 'org.matrix.custom.html', formatted_body: html } : {}),
    },
    'm.relates_to': {
      rel_type: 'm.replace',
      event_id: eventId,
    },
  };
  try {
    await client.sendEvent(roomId, 'm.room.message', content);
  } catch (e) {
    debug('Failed to edit message:', e.message);
  }
}

async function stripQueueNotificationLinks(session) {
  const notifs = session.queueNotifications || [];
  if (notifs.length === 0) return;
  session.queueNotifications = [];
  for (const { eventId, plain } of notifs) {
    await editMessage(session.roomId, eventId, plain);
  }
}

async function updateRoomName(roomId, name) {
  try {
    await client.sendStateEvent(roomId, 'm.room.name', '', { name });
  } catch (e) {
    debug(`Failed to update room name: ${e.message}`);
  }
}

async function maybeUpdatePinnedSummary(session) {
  if (!genAI) {
    debug('Skipping summary: genAI not configured');
    return;
  }

  if (!session.chatHistory) session.chatHistory = [];
  debug(`maybeUpdatePinnedSummary: chatHistory.length=${session.chatHistory.length}`);

  // Trigger every 5 messages
  if (session.chatHistory.length < 5 || session.chatHistory.length % 5 !== 0) return;

  try {
    // Use in-memory summary as source of truth (not Matrix, since getEvent returns original, not edits)
    let currentSummary = session.pinnedSummaryText || '';
    let bulletCount = (currentSummary.match(/^•/gm) || []).length;

    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

    // Check if we need to compact (>15 bullets)
    if (bulletCount > 15 && currentSummary) {
      const compactPrompt = `Condense this session summary into exactly 3 bullet points (using • prefix) capturing the key accomplishments. Keep it concise and focused on major milestones:\n\n${currentSummary}`;
      const compactResult = await model.generateContent(compactPrompt);
      currentSummary = compactResult.response.text().trim();
      bulletCount = (currentSummary.match(/^•/gm) || []).length;
      // Persist compacted result immediately so it isn't lost if the next LLM call fails to match
      session.pinnedSummaryText = currentSummary;
    }

    // Get last 50 messages for summarization (broad context for better titles)
    const recentMessages = session.chatHistory.slice(-50).map(m =>
      `${m.role}: ${m.text}`
    ).join('\n\n');

    const prompt = currentSummary
      ? `Based on these recent messages, provide:\n1. A 3-5 word title (max 34 chars) describing the overall topic/feature being worked on, e.g. "infrastructure documentation refinement" or "plan mode fix"\n2. A brief 1-sentence summary of what was accomplished\n\nFormat:\nTITLE: <title>\nNEW: <1 sentence>\n\nNo quotes. Be specific and concise.\n\nMessages:\n${recentMessages}`
      : `Based on these messages, provide:\n1. A 3-5 word title (max 34 chars) describing the overall topic/feature, e.g. "bridge room name truncation" or "voice note support"\n2. A 1-2 sentence summary (what's been done, current status)\n\nFormat:\nTITLE: <title>\nSUMMARY: <summary>\n\nNo quotes. Be specific.\n\nMessages:\n${recentMessages}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const titleMatch = text.match(/TITLE:\s*(.+)/i);
    const summaryMatch = text.match(/SUMMARY:\s*(.+)/i);
    const newMatch = text.match(/NEW:\s*(.+)/i);

    const sessionShort = (session.claudeSessionId || session.roomId.slice(1)).slice(0, 2);

    // Update room name (Element sidebar truncates visually, full name visible on hover)
    if (titleMatch) {
      const name = `${SERVER_LABEL}:${sessionShort} ${titleMatch[1].trim().slice(0, 60)}`;
      updateRoomName(session.roomId, name);
    }

    // Build cumulative summary for pinned message
    let updatedSummary = '';
    if (newMatch && currentSummary) {
      updatedSummary = `${currentSummary}\n• ${newMatch[1].trim()}`;
    } else if (summaryMatch && !currentSummary) {
      // Only use SUMMARY: for the initial summary, not after compaction
      updatedSummary = `• ${summaryMatch[1].trim()}`;
    } else if (currentSummary) {
      // LLM didn't produce a match — keep the existing summary (e.g. after compaction)
      updatedSummary = currentSummary;
    }

    if (updatedSummary) {
      // Store accumulated summary in session (source of truth)
      session.pinnedSummaryText = updatedSummary;
      if (session.claudeSessionId) {
        persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { chatHistory: session.chatHistory, pinnedSummaryText: updatedSummary, pinnedSummaryEventId: session.pinnedSummaryEventId || null });
      }

      const plainText = `📌 Session Summary\n\n${updatedSummary}`;
      const htmlText = `<b>📌 Session Summary</b><br/><br/>${escapeHtml(updatedSummary).replace(/\n/g, '<br/>')}`;

      if (session.pinnedSummaryEventId) {
        // Verify pinned message still exists; reset if deleted so next block creates a new one
        try {
          await client.getEvent(session.roomId, session.pinnedSummaryEventId);
          await editMessage(session.roomId, session.pinnedSummaryEventId, plainText, htmlText);
        } catch {
          session.pinnedSummaryEventId = null;
        }
      }
      if (!session.pinnedSummaryEventId) {
        // Create new pinned message
        const eventId = await client.sendMessage(session.roomId, {
          msgtype: 'm.text',
          body: plainText,
          format: 'org.matrix.custom.html',
          formatted_body: htmlText,
        });
        session.pinnedSummaryEventId = eventId;
        if (session.claudeSessionId) {
          persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { pinnedSummaryEventId: eventId });
        }

        // Pin the message
        try {
          const pinnedEvents = await client.getRoomStateEvent(session.roomId, 'm.room.pinned_events', '').catch(() => ({ pinned: [] }));
          const pinned = Array.isArray(pinnedEvents?.pinned) ? pinnedEvents.pinned : [];
          if (!pinned.includes(eventId)) {
            pinned.push(eventId);
            await client.sendStateEvent(session.roomId, 'm.room.pinned_events', '', { pinned });
          }
        } catch (e) {
          debug(`Failed to pin message: ${e.message}`);
        }
      }
    }
  } catch (e) {
    debug(`Failed to update pinned summary: ${e.message}`);
  }
}

function getSessionSummary(sessionId, workdir) {
  const encodedPath = encodeProjectDir(workdir || DEFAULT_WORKDIR);
  const filePath = path.join(os.homedir(), '.claude', 'projects', encodedPath, `${sessionId}.jsonl`);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.type === 'user' && record.message) {
        const msg = record.message;
        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.find(b => b.type === 'text')?.text || ''
            : '';
        if (text && !text.startsWith('<local-command') && !text.startsWith('<command-name>')) {
          const clean = text.replace(/<[^>]+>/g, '').trim();
          return clean.slice(0, 80) + (clean.length > 80 ? '…' : '');
        }
      }
    }
  } catch {}
  return '';
}

/**
 * Check if the session's JSONL history already contains a tool_result for the given tool_use_id.
 * This prevents sending duplicate tool_results which cause API 400 errors.
 */
function hasToolResultInHistory(sessionId, workdir, toolUseId, worktreeName) {
  const encodedPath = encodeProjectDir(workdir || DEFAULT_WORKDIR);
  // Check both base workdir and worktree transcript paths
  const candidates = [path.join(os.homedir(), '.claude', 'projects', encodedPath, `${sessionId}.jsonl`)];
  if (worktreeName) {
    candidates.push(path.join(os.homedir(), '.claude', 'projects', `${encodedPath}--claude-worktrees-${worktreeName}`, `${sessionId}.jsonl`));
  }
  for (const filePath of candidates) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        if (!line.includes(toolUseId)) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record.type === 'user' && Array.isArray(record.message?.content)) {
          for (const block of record.message.content) {
            if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
              return true;
            }
          }
        }
      }
    } catch {}
  }
  return false;
}

// --- Media Handling ---

async function downloadMatrixFile(mxcUrl, fileInfo) {
  // Use authenticated media endpoint (unauthenticated downloads are disabled on this homeserver)
  const urlParts = mxcUrl.replace('mxc://', '').split('/');
  const domain = encodeURIComponent(urlParts[0]);
  const mediaId = encodeURIComponent(urlParts[1]);
  const downloadUrl = `${MATRIX_HOMESERVER_URL}/_matrix/client/v1/media/download/${domain}/${mediaId}`;
  const res = await fetch(downloadUrl, {
    headers: { 'Authorization': `Bearer ${resolvedAccessToken}` }
  });
  if (!res.ok) throw new Error(`Media download failed: ${res.status} ${res.statusText}`);
  let buffer = Buffer.from(await res.arrayBuffer());

  // Decrypt if encrypted (E2E attachment)
  if (fileInfo?.key && fileInfo?.iv) {
    const { createDecipheriv } = await import('crypto');
    // Matrix uses AES-256-CTR with a JWK key
    const keyData = Buffer.from(fileInfo.key.k.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const iv = Buffer.from(fileInfo.iv, 'base64');
    const decipher = createDecipheriv('aes-256-ctr', keyData, iv);
    buffer = Buffer.concat([decipher.update(buffer), decipher.final()]);
  }

  return buffer;
}

async function buildMediaContentBlocks(event, session) {
  const blocks = [];
  const content = event.content;
  const mxcUrl = content.url || content.file?.url;

  if (!mxcUrl) return blocks;

  const buffer = await downloadMatrixFile(mxcUrl, content.file);
  const fileName = content.body || 'file';
  const mime = content.info?.mimetype || 'application/octet-stream';

  if (content.msgtype === 'm.audio') {
    const transcription = await transcribeAudio(buffer, mime, { modelPath: WHISPER_MODEL_PATH, language: WHISPER_LANGUAGE });
    blocks.push({ type: 'text', text: `[Voice note transcription]: ${transcription}` });
  } else if (session.iv) {
    // iv-mode: the PTY is text-only. Save the file OUTSIDE the repo and type
    // only an absolute-path annotation; Claude reads it with its Read tool.
    // No base64 blocks and no inline content dump (SDK mode keeps those).
    const { filename, caption } = resolveUploadMeta(content);
    const dir = ivUploadDir(session.roomId);
    const savePath = deduplicateFilename(dir, filename);
    fs.writeFileSync(savePath, buffer);
    blocks.push({ type: 'text', text: ivUploadAnnotation({ msgtype: content.msgtype, savePath, caption }) });
    return blocks; // caption already folded in; skip the SDK caption append below
  } else if (content.msgtype === 'm.image') {
    let imgPath;
    try { imgPath = deduplicateFilename(uploadsDir(session), fileName); }
    catch (err) { blocks.push({ type: 'text', text: `[Upload failed: ${err.message}]` }); return blocks; }
    fs.writeFileSync(imgPath, buffer);
    blocks.push({ type: 'text', text: `Image saved to ${imgPath}` });
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: mime, data: buffer.toString('base64') }
    });
  } else {
    let savePath;
    try { savePath = deduplicateFilename(uploadsDir(session), fileName); }
    catch (err) { blocks.push({ type: 'text', text: `[Upload failed: ${err.message}]` }); return blocks; }
    fs.writeFileSync(savePath, buffer);
    blocks.push({ type: 'text', text: `File saved to ${savePath}` });

    if (mime === 'application/pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') }
      });
    } else if (mime.startsWith('image/')) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data: buffer.toString('base64') }
      });
    } else if (mime.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript', 'application/csv'].includes(mime)) {
      blocks.push({ type: 'text', text: `Contents of ${fileName}:\n${buffer.toString('utf-8')}` });
    } else {
      blocks.push({ type: 'text', text: `Binary file (${mime}) saved to ${savePath}. Use the Read tool to inspect it if needed.` });
    }
  }

  // Caption: for m.file events, the filename differs from body when there's a caption
  if (content.msgtype === 'm.file' && content.filename !== content.body) {
    blocks.push({ type: 'text', text: content.body });
  }

  return blocks;
}

// --- Command Handler ---

async function handleCommand(roomId, text, sendReply, sendHtml, sender) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case '!start': {
      if (!sender) {
        await sendReply('Cannot determine sender. Please try again.');
        return;
      }

      // Parse --prompt from the RAW text FIRST (quote-aware), so flags inside a
      // quoted prompt aren't consumed by the token extractors below. Only the
      // !start case re-splits the prompt-stripped remainder; the top-level
      // `parts` (shared by all commands) is untouched.
      const { prompt: autoPrompt, rest: textSansPrompt, error: promptError } = extractPromptFlag(text);
      if (promptError) { await sendReply(promptError); return; }
      if (autoPrompt !== null && !INTERACTIVE_MODE) {
        await sendReply('--prompt is only supported in interactive mode (MATRON_INTERACTIVE_MODE=1).');
        return;
      }
      const startTokens = textSansPrompt.split(/\s+/).slice(1); // drop the "!start" token
      const { extras: mcpExtras, rest: afterExtras } = extractMcpExtraFlags(startTokens);
      const { worktree, error: worktreeError, rest: positional } = extractWorktreeFlag(afterExtras);
      if (worktreeError) {
        await sendReply(worktreeError);
        return;
      }
      const arg = positional[0];
      const forceFresh = arg === 'now' || arg === 'fresh';
      const explicitWorkdir = arg && !forceFresh ? arg : null;
      let workdir = DEFAULT_WORKDIR;
      if (explicitWorkdir) {
        const resolved = path.resolve(expandHome(explicitWorkdir));
        try {
          const stat = fs.statSync(resolved);
          if (!stat.isDirectory()) {
            await sendReply(`Not a directory: ${resolved}`);
            return;
          }
        } catch {
          await sendReply(`Directory not accessible: ${resolved}`);
          return;
        }
        workdir = resolved;
      }

      // Check for duplicate worktree before creating a room (room creation is irreversible)
      if (worktree && isWorktreeInUse(worktree, workdir)) {
        await sendReply(`Worktree "${worktree}" is already in use by another session. Pick a different name.`);
        return;
      }

      // Create a new room for this session (encrypted per ENCRYPT_SESSION_ROOMS).
      let sessionRoomId;
      try {
        sessionRoomId = await createSessionRoom(sender);
      } catch (e) {
        console.error('Failed to create session room:', e);
        await sendReply(`Failed to create session room: ${e.message}`);
        return;
      }

      const sessionSendReply = (reply) => sendToRoom(sessionRoomId, plainTextFormat(reply), markdownToHtml(reply));
      const sessionSendHtml = (plainText, html) => sendToRoom(sessionRoomId, plainText, html);
      const sessionSendButtons = (prompt, buttons, mode, plainText, html) =>
        sendButtonMessage(sessionRoomId, prompt, buttons, mode, plainText, html);
      const session = createSession(sessionRoomId, workdir, undefined, { mcpExtras, worktree });
      session.originRoomId = roomId;
      session.sendCallback = sessionSendReply;
      session.sendHtml = sessionSendHtml;
      session.sendButtonMessage = sessionSendButtons;
      // --prompt dispatch: the queued prompt fires when the operator joins the new
      // room (sendPendingWelcomeIfNeeded), after key-sharing — so the encrypted
      // transcript is fully readable. Set after the callbacks are wired; join always
      // happens later, so no construction race.
      if (autoPrompt !== null) session.pendingAutoPrompt = autoPrompt;
      // In iv-mode claudeSessionId is known immediately, so persist mcpExtras
      // now — otherwise a bridge restart before the first transcript-driven
      // persist would lose the user's opt-in. Print-mode sessions get their
      // claudeSessionId asynchronously and pick this up on the first persist.
      if ((mcpExtras.length > 0 || worktree) && session.claudeSessionId) {
        persistSession(sessionRoomId, session.claudeSessionId, session.workdir, roomId);
      }

      // Confirm in origin room with a link to the new room. R500: the queued-prompt
      // note is CONTENT-FREE (length only) — never echo the prompt text back.
      const roomLink = `https://matrix.to/#/${sessionRoomId}`;
      const extrasNote = mcpExtras.length > 0 ? ` (extras: ${mcpExtras.join(', ')})` : '';
      const worktreeNote = worktree ? ` (worktree: ${worktree})` : '';
      const promptNote = autoPrompt !== null ? `\nPrompt queued (${autoPrompt.length} chars) — fires automatically when the session is ready.` : '';
      await sendReply(`Session started in new room: ${roomLink}${extrasNote}${worktreeNote}${promptNote}`);

      // Welcome message will be sent when user joins (see room.join handler)
      break;
    }

    case '!esc':
    case '!escape': {
      const session = sessions.get(roomId);
      if (!session || !session.alive) {
        await sendReply('No active session.');
        break;
      }
      try {
        if (session.iv) {
          session.iv.sendKeystroke('esc');
          if (session.busy) {
            session.busy = false;
            if (session.typingInterval) {
              clearInterval(session.typingInterval);
              session.typingInterval = null;
              client.setTyping(session.roomId, false, 1000).catch(() => {});
            }
          }
        } else if (session.proc?.stdin?.writable) {
          const msg = JSON.stringify({
            type: 'control_request',
            request_id: randomUUID(),
            request: { subtype: 'interrupt' },
          }) + '\n';
          session.proc.stdin.write(msg);
        }
      } catch { /* ignore */ }
      session._interrupted = true;
      await sendReply('⎋ Interrupt sent — waiting for current turn to cancel.');
      break;
    }

    case '!clearall':
    case '!flush': {
      const session = sessions.get(roomId);
      if (!session) {
        await sendReply('No active session.');
        break;
      }
      const queue = session.queuedMessages || [];
      const notifs = session.queueNotifications || [];
      session.queuedMessages = null;
      session.queueNotifications = [];
      for (const { eventId, plain } of notifs) {
        if (eventId) editMessage(session.roomId, eventId, `✕ ${plain} (flushed)`);
      }
      await sendReply(queue.length > 0
        ? `🗑 Dropped ${queue.length} queued message${queue.length > 1 ? 's' : ''}.`
        : 'No queued messages to drop.');
      break;
    }

    case '!stop': {
      const session = sessions.get(roomId);
      if (!session || !session.alive) {
        await sendReply('No active session.');
        return;
      }
      killSession(session);
      sessions.delete(roomId);
      // Append [done] to the session room name
      try {
        const nameEvent = await client.getRoomStateEvent(session.roomId, 'm.room.name', '');
        const currentName = nameEvent?.name || '';
        if (currentName && !currentName.endsWith('[done]')) {
          updateRoomName(session.roomId, `${currentName} [done]`);
        }
      } catch { /* room name not set */ }
      await sendReply('Session stopped.');
      break;
    }

    case '!restart': {
      const existing = sessions.get(roomId);
      if (!existing || !existing.alive) {
        await sendReply('No active session. Use !start to begin.');
        return;
      }
      // /restart accepts the same MCP-extras flags as /start so you can
      // toggle browser tools on mid-conversation without losing the
      // session ID. Passing no flags preserves whatever extras the session
      // already has — set in-memory and falling back to the persisted
      // value if the bridge was restarted in between.
      const { extras: restartFlagExtras, rest: restartRest } = extractMcpExtraFlags(parts.slice(1));
      const { worktree: restartWorktree, error: restartWtError } = extractWorktreeFlag(restartRest);
      if (restartWtError) {
        await sendReply(restartWtError);
        return;
      }
      const effectiveWorktree = restartWorktree || existing.worktree || null;
      if (effectiveWorktree && isWorktreeInUse(effectiveWorktree, existing.workdir, roomId)) {
        await sendReply(`Worktree "${effectiveWorktree}" is already in use by another session.`);
        return;
      }
      const carriedExtras = Array.isArray(existing.mcpExtras) ? existing.mcpExtras : null;
      const effectiveRestartExtras = restartFlagExtras.length > 0
        ? restartFlagExtras
        : (carriedExtras || []);
      const restartSessionId = existing.claudeSessionId;
      const restartWorkdir = existing.workdir;
      sessions.delete(roomId);
      killSession(existing);
      await sendReply('🔄 Restarting session...');
      const restarted = createSession(roomId, restartWorkdir, restartSessionId, { mcpExtras: effectiveRestartExtras, worktree: effectiveWorktree });
      restarted.sendCallback = sendReply;
      restarted.sendHtml = sendHtml;
      restarted.sendButtonMessage = (prompt, buttons, mode, plainText, html) =>
        sendButtonMessage(roomId, prompt, buttons, mode, plainText, html);
      restarted.originRoomId = existing.originRoomId;
      restarted.firstMessageCaptured = existing.firstMessageCaptured;
      // Persist immediately so auto-resume works if the bridge restarts
      if (restartSessionId) {
        persistSession(roomId, restartSessionId, restartWorkdir, existing.originRoomId);
      }
      const extrasLine = effectiveRestartExtras.length > 0
        ? `\nExtras: ${effectiveRestartExtras.join(', ')}`
        : '';
      await sendReply(
        `Session restarted.\nSession: ${restartSessionId ? restartSessionId.slice(0, 8) + '...' : '(new)'}\nWorkdir: ${restartWorkdir}${extrasLine}`
      );
      break;
    }

    case '!resume': {
      if (!sender) {
        await sendReply('Cannot determine sender. Please try again.');
        return;
      }

      const { extras: resumeExtras, rest: resumeTokens } = extractMcpExtraFlags(parts.slice(1));
      const resumeArg = resumeTokens[0]?.replace(/\.+$/, '') || undefined;

      if (!resumeArg) {
        // No arg — show sessions list inline
        await handleCommand(roomId, '!sessions', sendReply, sendHtml, sender);
        return;
      }

      const currentSession = sessions.get(roomId);
      const prev = getPersistedSession(roomId);
      const resumeWorkdir = currentSession?.workdir || prev?.workdir || DEFAULT_WORKDIR;
      const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
      const encodedPath = encodeProjectDir(resumeWorkdir);

      const projectDir = path.join(projectsRoot, encodedPath);

      // Build session list from base workdir + persisted worktree sessions
      const resumeFiles = [];
      const seenResumeIds = new Set();
      try {
        for (const f of fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))) {
          const sid = f.replace('.jsonl', '');
          const stat = fs.statSync(path.join(projectDir, f));
          resumeFiles.push({ sid, mtimeMs: stat.mtimeMs });
          seenResumeIds.add(sid);
        }
      } catch { /* dir doesn't exist */ }
      const allPersistedForResume = loadPersistedSessions();
      for (const entry of Object.values(allPersistedForResume)) {
        if (!entry.sessionId || seenResumeIds.has(entry.sessionId)) continue;
        if (!entry.worktree) continue;
        if (entry.workdir && entry.workdir !== resumeWorkdir) continue;
        const wtEncoded = `${encodedPath}--claude-worktrees-${entry.worktree}`;
        const wtPath = path.join(projectsRoot, wtEncoded, `${entry.sessionId}.jsonl`);
        let mtimeMs = entry.lastUsed || Date.now();
        try { mtimeMs = fs.statSync(wtPath).mtimeMs; } catch { /* short session, no transcript yet */ }
        resumeFiles.push({ sid: entry.sessionId, mtimeMs });
        seenResumeIds.add(entry.sessionId);
      }

      if (resumeFiles.length === 0) {
        await sendReply(`No sessions found for workdir: ${resumeWorkdir}`);
        return;
      }

      resumeFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const sortedFiles = resumeFiles.map(f => f.sid);

      let resumeSessionId;
      let actualWorkdir = resumeWorkdir;
      const num = /^\d+$/.test(resumeArg) ? parseInt(resumeArg, 10) : NaN;
      if (!isNaN(num) && num >= 1 && num <= sortedFiles.length) {
        resumeSessionId = sortedFiles[num - 1];
      } else {
        const match = sortedFiles.find(f => f.startsWith(resumeArg));
        if (match) {
          resumeSessionId = match;
        } else {
          // Session not found in current workdir — check persisted sessions for a different workdir
          const allPersisted = loadPersistedSessions();
          let foundEntry = null;
          for (const entry of Object.values(allPersisted)) {
            if (entry.sessionId && entry.sessionId.startsWith(resumeArg) && entry.workdir && entry.workdir !== resumeWorkdir) {
              foundEntry = entry;
              break;
            }
          }
          if (foundEntry) {
            const altEncoded = encodeProjectDir(foundEntry.workdir);
            // Check base transcript path, then worktree transcript path
            const altDir = path.join(os.homedir(), '.claude', 'projects', altEncoded);
            const altFile = path.join(altDir, `${foundEntry.sessionId}.jsonl`);
            const wtDir = foundEntry.worktree
              ? path.join(os.homedir(), '.claude', 'projects', `${altEncoded}--claude-worktrees-${foundEntry.worktree}`)
              : null;
            const wtFile = wtDir ? path.join(wtDir, `${foundEntry.sessionId}.jsonl`) : null;
            if (fs.existsSync(altFile) || (wtFile && fs.existsSync(wtFile))) {
              resumeSessionId = foundEntry.sessionId;
              actualWorkdir = foundEntry.workdir;
            }
          }
          if (!resumeSessionId) {
            await sendReply(`Session not found: ${resumeArg}\nUse !sessions to list available sessions.`);
            return;
          }
        }
      }

      // Check if there's already an active room for this Claude session
      for (const [activeRoomId, activeSession] of sessions) {
        if (activeSession.claudeSessionId === resumeSessionId && activeSession.alive) {
          const roomLink = `https://matrix.to/#/${activeRoomId}`;
          await sendReply(`Session ${resumeSessionId.slice(0, 8)}… is already active: ${roomLink}`);
          return;
        }
      }

      // Validate worktree constraints before creating a room (room creation is irreversible)
      const resumePersisted = (resumeSessionId
        ? Object.values(loadPersistedSessions()).find(e => e.sessionId === resumeSessionId)
        : null);
      const effectiveResumeWorktree = resumePersisted?.worktree || null;
      if (effectiveResumeWorktree && isWorktreeInUse(effectiveResumeWorktree, actualWorkdir)) {
        await sendReply(`Worktree "${effectiveResumeWorktree}" is already in use by another session.`);
        return;
      }

      // Create a new room for the resumed session
      let sessionRoomId;
      try {
        sessionRoomId = await createSessionRoom(sender);
      } catch (e) {
        console.error('Failed to create session room:', e);
        await sendReply(`Failed to create session room: ${e.message}`);
        return;
      }

      const shortId = resumeSessionId.slice(0, 8);
      const summary = getSessionSummary(resumeSessionId, actualWorkdir);
      const roomName = summary
        ? `${SERVER_LABEL}: ${summary.slice(0, 50)}${summary.length > 50 ? '…' : ''}`
        : `${SERVER_LABEL}: Resumed ${shortId}`;
      await updateRoomName(sessionRoomId, roomName);

      const sessionSendReply = (reply) => sendToRoom(sessionRoomId, plainTextFormat(reply), markdownToHtml(reply));
      const sessionSendHtml = (plainText, html) => sendToRoom(sessionRoomId, plainText, html);
      const sessionSendButtons = (prompt, buttons, mode, plainText, html) =>
        sendButtonMessage(sessionRoomId, prompt, buttons, mode, plainText, html);

      const effectiveResumeExtras = resumeExtras.length > 0
        ? resumeExtras
        : (Array.isArray(resumePersisted?.mcpExtras) ? resumePersisted.mcpExtras : []);
      const session = createSession(sessionRoomId, actualWorkdir, resumeSessionId, { mcpExtras: effectiveResumeExtras, worktree: effectiveResumeWorktree });
      session.originRoomId = roomId;
      session.firstMessageCaptured = true; // don't re-rename on first message
      session.sendCallback = sessionSendReply;
      session.sendHtml = sessionSendHtml;
      session.sendButtonMessage = sessionSendButtons;

      // Persist immediately — we already know the session ID, don't wait for Claude's event
      persistSession(sessionRoomId, resumeSessionId, actualWorkdir, roomId);

      const roomLink = `https://matrix.to/#/${sessionRoomId}`;
      await sendReply(`Resuming session ${shortId}… in new room: ${roomLink}`);
      const resumePlain = `Resuming session ${shortId}…\nWorkdir: ${actualWorkdir}\n\nSend any message to continue.`;
      const resumeHtml =
        `<b>Resuming session <code>${shortId}</code>…</b><br/>` +
        `Workdir: <code>${escapeHtml(actualWorkdir)}</code><br/><br/>` +
        `<i>Send any message to continue.</i>`;
      await sessionSendHtml(resumePlain, resumeHtml);
      break;
    }

    case '!workdir': {
      if (!sender) {
        await sendReply('Cannot determine sender. Please try again.');
        return;
      }

      const { extras: workdirExtras, rest: workdirTokens } = extractMcpExtraFlags(parts.slice(1));
      const newDir = workdirTokens.join(' ');
      if (!newDir) {
        const session = sessions.get(roomId);
        const current = session?.workdir || DEFAULT_WORKDIR;
        await sendReply(`Current workdir: ${current}\n\nUsage: !workdir <path>`);
        return;
      }

      const resolved = path.resolve(expandHome(newDir));

      try {
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
          await sendReply(`Not a directory: ${resolved}`);
          return;
        }
      } catch {
        await sendReply(`Directory not accessible: ${resolved}`);
        return;
      }

      // Create a new room for this session
      let sessionRoomId;
      try {
        sessionRoomId = await createSessionRoom(sender);
      } catch (e) {
        console.error('Failed to create session room:', e);
        await sendReply(`Failed to create session room: ${e.message}`);
        return;
      }

      const sessionSendReply = (reply) => sendToRoom(sessionRoomId, plainTextFormat(reply), markdownToHtml(reply));
      const sessionSendHtml = (plainText, html) => sendToRoom(sessionRoomId, plainText, html);
      const sessionSendButtons = (prompt, buttons, mode, plainText, html) =>
        sendButtonMessage(sessionRoomId, prompt, buttons, mode, plainText, html);

      const session = createSession(sessionRoomId, resolved, undefined, { mcpExtras: workdirExtras });
      session.originRoomId = roomId;
      session.sendCallback = sessionSendReply;
      session.sendHtml = sessionSendHtml;
      session.sendButtonMessage = sessionSendButtons;
      if (workdirExtras.length > 0 && session.claudeSessionId) {
        persistSession(sessionRoomId, session.claudeSessionId, session.workdir, roomId);
      }

      const roomLink = `https://matrix.to/#/${sessionRoomId}`;
      await sendReply(`Session started in new room: ${roomLink}\nWorkdir: ${resolved}`);
      const wdPlain = `Session started.\nWorkdir: ${resolved}\n\nSend any message to interact with Claude Code.`;
      const wdHtml =
        `<b>Session started</b><br/>` +
        `Workdir: <code>${escapeHtml(resolved)}</code><br/><br/>` +
        `<i>Send any message to interact with Claude Code.</i>`;
      await sessionSendHtml(wdPlain, wdHtml);
      break;
    }

    case '!label': {
      const newLabel = text.replace(/^!\w+\s*/, '').trim();
      if (!newLabel) {
        await sendReply(`Current server label: ${SERVER_LABEL}`);
      } else if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(sender)) {
        await sendReply('Only allowed users can change the server label.');
      } else if (!/^[A-Za-z0-9_. -]{1,16}$/.test(newLabel)) {
        await sendReply('Label must be 1-16 characters: letters, numbers, spaces, _ . -');
      } else {
        SERVER_LABEL = newLabel;
        await sendReply(`Server label set to: ${SERVER_LABEL}`);
      }
      break;
    }

    case '!who':
    case '!role': {
      const args = text.replace(/^!\w+\s*/, '').trim().split(/\s+/).filter(Boolean);
      const senderRole = getUserRole(sender);

      if (args.length === 0 && cmd === '!role') {
        await sendReply(`${sender}: ${senderRole}`);
      } else if (cmd === '!who' || (args.length > 0 && args[0] === 'list')) {
        if (senderRole !== 'admin') {
          await sendReply('Only admins can list all roles.');
          break;
        }
        const lines = [];
        const allUsers = new Set([...ALLOWED_USER_IDS, ...roles.keys()]);
        for (const uid of allUsers) {
          const role = getUserRole(uid);
          lines.push(`${uid}: ${role}`);
        }
        await sendReply(lines.length > 0 ? lines.join('\n') : 'No users configured.');
      } else if (args.length === 2) {
        if (senderRole !== 'admin') {
          await sendReply('Only admins can assign roles.');
          break;
        }
        const [targetUser, newRole] = args;
        if (newRole !== 'admin' && newRole !== 'member') {
          await sendReply('Role must be "admin" or "member".');
          break;
        }
        if (!targetUser.startsWith('@') || !targetUser.includes(':')) {
          await sendReply('User must be a full Matrix ID (e.g. @user:server).');
          break;
        }
        if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(targetUser)) {
          await sendReply('Cannot assign roles to users outside the allowlist.');
          break;
        }
        if (newRole === 'member' && getUserRole(targetUser) === 'admin') {
          const allowedAdmins = (ALLOWED_USER_IDS.length > 0 ? ALLOWED_USER_IDS : [...roles.keys()])
            .filter(uid => getUserRole(uid) === 'admin');
          if (allowedAdmins.length <= 1) {
            await sendReply('Cannot demote the last admin.');
            break;
          }
        }
        const prevRole = roles.get(targetUser);
        roles.set(targetUser, newRole);
        if (!saveRoles()) {
          if (prevRole) roles.set(targetUser, prevRole);
          else roles.delete(targetUser);
          await sendReply('Failed to save role — change rolled back.');
          break;
        }
        await sendReply(`${targetUser} is now ${newRole}.`);
      } else {
        await sendReply('Usage: !role @user:server admin|member');
      }
      break;
    }

    case '!status': {
      const session = sessions.get(roomId);
      if (!session || !session.alive) {
        await sendReply('No active session. Send !start to begin.');
        return;
      }
      const uptimeMs = Date.now() - session.startedAt;
      const shortId = session.claudeSessionId ? session.claudeSessionId.slice(0, 8) + '…' : '(pending)';
      const busyText = session.busy ? 'yes' : 'no';

      const worktreeText = session.worktree ? `\nWorktree: ${session.worktree}` : '';
      const plainStatus =
        `Session active\nWorkdir: ${session.workdir}${worktreeText}\nSession ID: ${shortId}\n` +
        `Uptime: ${formatDuration(uptimeMs)}\nRestarts: ${session.restartCount}/3\nBusy: ${busyText}`;

      const busyHtml = session.busy
        ? color('● busy', '#f0883e')
        : color('● idle', '#3fb950');
      const worktreeRow = session.worktree
        ? `<tr><td>Worktree</td><td><code>${escapeHtml(session.worktree)}</code></td></tr>`
        : '';
      const htmlStatus =
        `<b>Session Status</b><table>` +
        `<tr><td>State</td><td>${busyHtml}</td></tr>` +
        `<tr><td>Workdir</td><td><code>${escapeHtml(session.workdir)}</code></td></tr>` +
        worktreeRow +
        `<tr><td>Session</td><td><code>${shortId}</code></td></tr>` +
        `<tr><td>Uptime</td><td>${formatDuration(uptimeMs)}</td></tr>` +
        `<tr><td>Restarts</td><td>${session.restartCount}/3</td></tr>` +
        `<tr><td>Turns</td><td>${session.turnCount}</td></tr>` +
        `<tr><td>Cost</td><td>$${session.totalUsage.cost_usd.toFixed(4)}</td></tr>` +
        `</table>`;

      await sendHtml(plainStatus, htmlStatus);
      break;
    }

    case '!show':
    case '!show_working':
    case '!working': {
      const session = sessions.get(roomId);
      if (!session) {
        await sendReply('No active session.');
        break;
      }
      session.showWorking = !session.showWorking;
      await sendReply(`Tool call visibility: ${session.showWorking ? 'ON — will show working' : 'OFF — hidden'}`);
      break;
    }

    case '!show_bash':
    case '!show_bash_output':
    case '!bash_output': {
      const session = sessions.get(roomId);
      if (!session) {
        await sendReply('No active session.');
        break;
      }
      session.showBashOutput = !session.showBashOutput;
      // Persist so !restart re-reads the value at spawn. Gated like the
      // pendingPlanDenialId persist at the ExitPlanMode handler — passing a
      // null sessionId here would clobber an existing persisted sessionId.
      if (session.claudeSessionId) {
        persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { showBashOutput: session.showBashOutput });
      }
      await sendReply(`showBashOutput: ${session.showBashOutput ? 'ON' : 'OFF'} — run !restart to apply`);
      break;
    }

    case '!sessions': {
      const currentSession = sessions.get(roomId);
      const prev = getPersistedSession(roomId);
      const workdir = currentSession?.workdir || prev?.workdir || DEFAULT_WORKDIR;

      // Scan the base workdir project dir for transcripts, then augment
      // with persisted sessions (which include worktree sessions that
      // have transcripts in different project dirs).
      const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
      const encodedPath = encodeProjectDir(workdir);
      const projectDir = path.join(projectsRoot, encodedPath);

      const files = [];
      const seenIds = new Set();
      // 1. Scan base workdir transcripts
      try {
        for (const f of fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))) {
          const sessionId = f.replace('.jsonl', '');
          const stat = fs.statSync(path.join(projectDir, f));
          const summary = getSessionSummary(sessionId, workdir);
          files.push({ sessionId, modified: stat.mtimeMs, summary });
          seenIds.add(sessionId);
        }
      } catch { /* dir doesn't exist */ }
      // 2. Add persisted worktree sessions whose transcripts live elsewhere
      const allPersisted = loadPersistedSessions();
      for (const entry of Object.values(allPersisted)) {
        if (!entry.sessionId || seenIds.has(entry.sessionId)) continue;
        if (!entry.worktree) continue;
        if (entry.workdir && entry.workdir !== workdir) continue;
        // Find the transcript in the worktree project dir
        const wtEncoded = `${encodedPath}--claude-worktrees-${entry.worktree}`;
        const wtPath = path.join(projectsRoot, wtEncoded, `${entry.sessionId}.jsonl`);
        let modified = entry.lastUsed || Date.now();
        try {
          modified = fs.statSync(wtPath).mtimeMs;
        } catch { /* transcript may not exist yet for short sessions */ }
        const summary = getSessionSummary(entry.sessionId, workdir) || `[worktree: ${entry.worktree}]`;
        files.push({ sessionId: entry.sessionId, modified, summary, worktree: entry.worktree });
        seenIds.add(entry.sessionId);
      }
      files.sort((a, b) => b.modified - a.modified);

      if (files.length === 0) {
        await sendReply('No sessions found.');
        break;
      }

      const activeId = currentSession?.claudeSessionId;
      const items = files.slice(0, 15);

      // Plain text fallback
      const plainList = items.map((s, i) => {
        const date = new Date(s.modified).toISOString().replace('T', ' ').slice(0, 16);
        const shortId = s.sessionId.slice(0, 8);
        const active = s.sessionId === activeId ? ' ⚡' : '';
        const desc = s.summary ? ` — ${s.summary}` : '';
        return `${i + 1}. ${shortId} ${date}${active}${desc}`;
      }).join('\n');

      // HTML formatted version
      const htmlRows = items.map((s, _i) => {
        const date = new Date(s.modified).toISOString().replace('T', ' ').slice(0, 16);
        const shortId = s.sessionId.slice(0, 8);
        const active = s.sessionId === activeId ? ' ⚡' : '';
        const desc = s.summary
          ? `<br/><span style="color:gray">${escapeHtml(s.summary)}</span>`
          : '';
        return `<li><b>${shortId}</b> <code>${date}</code>${active}${desc}</li>`;
      }).join('\n');

      const plainText = `Sessions for ${workdir}:\n\n${plainList}\n\nUse /resume <number> or /resume <id> to resume.`;
      const html = `<b>Sessions for ${escapeHtml(workdir)}:</b><ol>\n${htmlRows}\n</ol><i>Use <code>/resume &lt;number&gt;</code> or <code>/resume &lt;id&gt;</code> to resume.</i>`;

      await sendHtml(plainText, html);
      break;
    }

    case '!help': {
      const plainHelp =
        `Bridge commands (use ! prefix):\n\n` +
        `Sessions:\n` +
        `  !start — Start a new session (creates a new room)\n` +
        `  !start <workdir> — Start in a specific directory\n` +
        `  !start --browser [workdir] — Add chrome-devtools MCP (~400M)\n` +
        `  !start --worktree <name> — Isolated git worktree (branch: worktree-<name>)\n` +
        `  !esc — Interrupt current turn (jumps the queue)\n` +
        `  !clearall — Drop all queued messages\n` +
        `  !stop — Stop the current session\n` +
        `  !restart — Stop and resume (--browser, --worktree accepted)\n` +
        `  !resume <n|id> — Resume session by number or ID (--browser accepted)\n` +
        `  !sessions — List all past sessions\n` +
        `  !workdir <path> — Change directory and restart (--browser accepted)\n\n` +
        `Info:\n` +
        `  !status — Session uptime, workdir, restarts\n` +
        `  !working — Toggle tool call visibility\n` +
        `  !label [name] — Show or set server label\n` +
        `  !role — Show your role, or !role @user admin|member (admin only)\n` +
        `  !who — List all users and roles (admin only)\n` +
        `  !mcp — MCP server status\n` +
        `  !model — Current model\n` +
        `  !cost — Session cost\n` +
        `  !usage — Token usage\n` +
        `  !tools — Available tools\n` +
        `  !help — This help message\n\n` +
        `Use ! for bridge commands. / also works for the above, but\n` +
        `unrecognized / commands are forwarded to Claude Code CLI.\n\n` +
        `Each !start, !resume, and !workdir creates a new ${ENCRYPT_SESSION_ROOMS ? 'encrypted ' : ''}room.\n` +
        `Room names show the server (${SERVER_LABEL}) and first message summary.\n\n` +
        `While Claude is working:\n` +
        `  Messages are queued automatically\n` +
        `  "send" or "interrupt" to flush the queue now\n` +
        `  !esc to cancel the current turn (never queued)\n` +
        `  "cancel" to drop last queued message\n\n` +
        `You can also send photos and documents (PDFs, images, text files).`;

      const cmdGroup = (title, cmds) => {
        const items = cmds.map(([c, d]) => `<li><code>${c}</code> — ${d}</li>`).join('');
        return `<b>${title}</b><ul>${items}</ul>`;
      };

      const htmlHelp =
        cmdGroup('Sessions', [
          ['!start', 'Start a new session (creates a new room)'],
          ['!start &lt;workdir&gt;', 'Start in a specific directory'],
          ['!start --browser [workdir]', 'Also enable chrome-devtools MCP (~400M)'],
          ['!start --worktree &lt;slug&gt; --prompt "…"', 'Dispatch a worktree session; the prompt fires automatically as your first message when you open the new room. Interactive-mode only.'],
          ['!esc', 'Interrupt current turn (jumps the queue)'],
          ['!clearall', 'Drop all queued messages'],
          ['!stop', 'Stop the current session'],
          ['!restart', 'Stop and resume (--browser accepted)'],
          ['!resume &lt;n|id&gt;', 'Resume session by number or ID (--browser accepted)'],
          ['!sessions', 'List all past sessions'],
          ['!workdir &lt;path&gt;', 'Change directory and restart (--browser accepted)'],
        ]) +
        cmdGroup('Info', [
          ['!status', 'Session uptime, workdir, restarts'],
          ['!working', 'Toggle tool call visibility'],
          ['!label [name]', 'Show or set server label'],
          ['!role [@user admin|member]', 'Show or assign roles (admin only)'],
          ['!who', 'List all users and roles (admin only)'],
          ['!mcp', 'MCP server status'],
          ['!model', 'Current model'],
          ['!cost', 'Session cost'],
          ['!usage', 'Token usage'],
          ['!tools', 'Available tools'],
          ['!help', 'This help message'],
        ]) +
        `<b>Tips</b><ul>` +
        `<li>Use <code>!</code> for bridge commands. <code>/</code> also works for the above, but unrecognized <code>/</code> commands forward to Claude Code CLI.</li>` +
        `<li>Each <code>!start</code>, <code>!resume</code>, and <code>!workdir</code> creates a new ${ENCRYPT_SESSION_ROOMS ? 'encrypted ' : ''}room</li>` +
        `<li>Room names show the server (<code>${SERVER_LABEL}</code>) and first message summary</li>` +
        `<li>Messages are queued automatically while Claude is working</li>` +
        `<li><code>send</code>/<code>interrupt</code> flush the queue; <code>!esc</code> cancels the turn; <code>cancel</code> drops last queued message</li>` +
        `<li>You can send photos and documents (PDFs, images, text files)</li>` +
        `</ul>`;

      await sendHtml(plainHelp, htmlHelp);
      break;
    }

    case '!mcp': {
      const session = sessions.get(roomId);
      if (session?.initData?.mcp_servers) {
        const servers = session.initData.mcp_servers;
        const plainList = servers.map(s => {
          const icon = s.status === 'connected' ? '🟢' :
                       s.status === 'failed' ? '🔴' :
                       s.status === 'needs-auth' ? '🟡' : '⚪';
          return `${icon} ${s.name} — ${s.status}`;
        }).join('\n');
        const statusDot = (st) => {
          const clr = st === 'connected' ? '#3fb950' :
                      st === 'failed' ? '#f85149' :
                      st === 'needs-auth' ? '#f0883e' : '#8b949e';
          return color('●', clr);
        };
        const htmlRows = servers.map(s =>
          `<tr><td>${statusDot(s.status)}</td><td><code>${escapeHtml(s.name)}</code></td><td>${escapeHtml(s.status)}</td></tr>`
        ).join('');
        const htmlMcp = `<b>MCP Servers</b><table>${htmlRows}</table>`;
        await sendHtml(`MCP Servers (live):\n\n${plainList}`, htmlMcp);
      } else {
        try {
          const configPath = path.join(__dirname, 'mcp-config.json');
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          const names = Object.keys(config.mcpServers || {});
          if (names.length === 0) {
            await sendReply('No MCP servers configured.');
          } else {
            const list = names.map(n => `⚪ ${n} — configured`).join('\n');
            await sendReply(`MCP Servers (from config, no active session):\n\n${list}\n\nStart a session to see live status.`);
          }
        } catch {
          await sendReply('No MCP config found and no active session.');
        }
      }
      break;
    }

    case '!model': {
      const session = sessions.get(roomId);
      if (session?.initData) {
        const model = session.initData.model || '(unknown)';
        const version = session.initData.claude_code_version || '(unknown)';
        const fast = session.initData.fast_mode_state || 'off';
        await sendReply(`Model: ${model}\nClaude Code: v${version}\nFast mode: ${fast}`);
      } else {
        await sendReply('No active session. Start a session to see model info.');
      }
      break;
    }

    case '!cost': {
      const session = sessions.get(roomId);
      if (!session) {
        await sendReply('No active session.');
        break;
      }
      const cost = session.totalUsage.cost_usd;
      const costClr = cost < 0.5 ? '#3fb950' : cost < 2 ? '#f0883e' : '#f85149';
      const plainCost = `Session cost: $${cost.toFixed(4)}\nTurns: ${session.turnCount}`;
      const htmlCost =
        `<b>Session Cost</b><table>` +
        `<tr><td>Cost</td><td>${color('$' + cost.toFixed(4), costClr)}</td></tr>` +
        `<tr><td>Turns</td><td>${session.turnCount}</td></tr>` +
        `</table>`;
      await sendHtml(plainCost, htmlCost);
      break;
    }

    case '!usage': {
      const session = sessions.get(roomId);
      if (!session) {
        await sendReply('No active session.');
        break;
      }
      const u = session.totalUsage;
      const uCostClr = u.cost_usd < 0.5 ? '#3fb950' : u.cost_usd < 2 ? '#f0883e' : '#f85149';
      const plainUsage =
        `Token usage (cumulative):\n\n` +
        `Input: ${u.input_tokens.toLocaleString()}\n` +
        `Output: ${u.output_tokens.toLocaleString()}\n` +
        `Cache read: ${u.cache_read.toLocaleString()}\n` +
        `Cache create: ${u.cache_create.toLocaleString()}\n` +
        `Turns: ${session.turnCount}\n` +
        `Cost: $${u.cost_usd.toFixed(4)}`;
      const htmlUsage =
        `<b>Token Usage</b><table>` +
        `<tr><td>Input</td><td>${u.input_tokens.toLocaleString()}</td></tr>` +
        `<tr><td>Output</td><td>${u.output_tokens.toLocaleString()}</td></tr>` +
        `<tr><td>Cache read</td><td>${u.cache_read.toLocaleString()}</td></tr>` +
        `<tr><td>Cache create</td><td>${u.cache_create.toLocaleString()}</td></tr>` +
        `<tr><td>Turns</td><td>${session.turnCount}</td></tr>` +
        `<tr><td>Cost</td><td>${color('$' + u.cost_usd.toFixed(4), uCostClr)}</td></tr>` +
        `</table>`;
      await sendHtml(plainUsage, htmlUsage);
      break;
    }

    case '!tools': {
      const session = sessions.get(roomId);
      if (!session?.initData?.tools) {
        await sendReply('No session data available. Start a session first.');
        break;
      }
      const tools = session.initData.tools;
      const mcpTools = tools.filter(t => t.startsWith('mcp__'));
      const builtIn = tools.filter(t => !t.startsWith('mcp__'));

      // Plain text
      let plainMsg = `Built-in tools (${builtIn.length}):\n${builtIn.join(', ')}\n\n`;
      const grouped = {};
      for (const t of mcpTools) {
        const tParts = t.split('__');
        const server = tParts[1] || 'unknown';
        if (!grouped[server]) grouped[server] = [];
        grouped[server].push(tParts[2] || t);
      }
      if (mcpTools.length > 0) {
        plainMsg += `MCP tools:\n`;
        for (const [server, serverTools] of Object.entries(grouped)) {
          plainMsg += `  ${server} (${serverTools.length}): ${serverTools.join(', ')}\n`;
        }
      }

      // HTML
      let htmlMsg = `<b>Built-in tools (${builtIn.length})</b><br/>` +
        builtIn.map(t => `<code>${escapeHtml(t)}</code>`).join(', ');
      if (mcpTools.length > 0) {
        for (const [server, serverTools] of Object.entries(grouped)) {
          htmlMsg += `<details><summary><b>${escapeHtml(server)}</b> (${serverTools.length})</summary>` +
            serverTools.map(t => `<code>${escapeHtml(t)}</code>`).join(', ') +
            `</details>`;
        }
      }

      await sendHtml(plainMsg, htmlMsg);
      break;
    }

    default:
      break;
  }
}

// --- Matrix Message Handler ---

client.on('room.message', async (roomId, event) => {
  try {
  // Ignore own messages
  if (event.sender === botUserId) return;
  // Ignore non-message events and edits
  if (!event.content?.msgtype) return;
  if (event.content['m.relates_to']?.rel_type === 'm.replace') return;

  // Skip events we already processed before a restart (per-room tracking).
  // Only apply dedup for events that predate bot startup — these are sync replays.
  // Events newer than startup can't be replays and are always processed, even if
  // federated clock skew makes their timestamp slightly out of order.
  const eventTs = event.origin_server_ts || 0;
  const roomLastTs = lastEventTsMap[roomId] || 0;
  if (eventTs < botStartupTs && eventTs <= roomLastTs) {
    debug(`Skipping already-processed event in ${roomId} (ts: ${eventTs}, last: ${roomLastTs})`);
    return;
  }
  if (eventTs > roomLastTs) {
    lastEventTsMap[roomId] = eventTs;
    lastEventTsDirty = true;
  }

  const sender = event.sender;
  if (warnIfDisallowed(sender, roomId)) return;

  const msgtype = event.content.msgtype;
  let text = '';
  let hasMedia = false;

  if (msgtype === 'm.text' || msgtype === 'm.notice') {
    text = (event.content.body || '').trim();
  } else if (msgtype === 'm.image' || msgtype === 'm.file' || msgtype === 'm.audio') {
    hasMedia = true;
    text = (event.content.body || '').trim();
  }

  if (!text && !hasMedia) return;

  // R500: redact any --prompt value before logging — this runs before command
  // parsing, so a `!start --prompt "secret"` would otherwise leak into service logs.
  const logText = text.replace(/--prompt\s+.*/s, '--prompt <redacted>');
  console.log(
    `Message from ${sender} in ${roomId}: ${logText.slice(0, 50)}${hasMedia ? ' [media]' : ''}`
  );

  const sendReply = (reply) => sendToRoom(roomId, plainTextFormat(reply), markdownToHtml(reply));
  const sendHtmlFn = (plainText, html) => sendToRoom(roomId, plainText, html);

  // Bridge commands use / or ! prefix
  if (text.startsWith('!') || text.startsWith('/')) {
    const bridgeCommandNames = new Set([
      'start', 'stop', 'restart', 'resume', 'workdir', 'status',
      'show', 'show_working', 'working', 'sessions', 'help',
      'mcp', 'model', 'cost', 'usage', 'tools',
      'esc', 'escape', 'clearall', 'flush',
      'label', 'role', 'who',
    ]);
    const firstWord = text.split(/\s+/)[0].toLowerCase();
    const cmdName = firstWord.slice(1); // strip ! or /
    if (bridgeCommandNames.has(cmdName)) {
      // Normalize to ! prefix for the handler
      const normalizedText = '!' + text.slice(1);
      await handleCommand(roomId, normalizedText, sendReply, sendHtmlFn, sender);
      return;
    }
    // Fall through — forward to Claude Code session
  }

  // Forward to Claude Code session
  let session = sessions.get(roomId);
  if (!session || !session.alive) {
    // Auto-resume if this room has a persisted session (session-specific room)
    const prev = getPersistedSession(roomId);
    if (prev && prev.sessionId) {
      // Clean up dead session if present
      if (session) sessions.delete(roomId);

      const newSession = createSession(roomId, prev.workdir || DEFAULT_WORKDIR, prev.sessionId);
      newSession.originRoomId = prev.originRoomId || null;
      newSession.firstMessageCaptured = true;
      newSession.chatHistory = prev.chatHistory || [];
      newSession.pinnedSummaryText = prev.pinnedSummaryText || '';
      newSession.pinnedSummaryEventId = prev.pinnedSummaryEventId || null;
      newSession.sendCallback = sendReply;
      newSession.sendHtml = sendHtmlFn;
      newSession.sendButtonMessage = (prompt, buttons, mode, plainText, html) =>
        sendButtonMessage(roomId, prompt, buttons, mode, plainText, html);
      session = newSession;

      const shortId = prev.sessionId.slice(0, 8);
      const arNotice = notice('info', `Auto-resuming session ${shortId}…`, `Auto-resuming session <code>${shortId}</code>…`);
      await sendHtmlFn(arNotice.plain, arNotice.html);
      // Hold this (and any further) message until the resumed TUI is ready —
      // claude --resume + auto-compaction can take seconds, far longer than
      // the paste→Enter window, so an immediate type-in is silently dropped.
      enterResumeHold(session);
    } else {
      // Auto-start a session in this room
      const workdir = DEFAULT_WORKDIR;
      const newSession = createSession(roomId, workdir);
      newSession.sendCallback = sendReply;
      newSession.sendHtml = sendHtmlFn;
      session = newSession;

      const autoNotice = notice('info',
        `Session started.\nWorkdir: ${workdir}`,
        `<b>Session started</b><br/>Workdir: <code>${escapeHtml(workdir)}</code>`);
      await sendHtmlFn(autoNotice.plain, autoNotice.html);
    }
  }

  // iv-mode: route reply to a pending TUI prompt before treating it as a
  // normal message. If we consumed it as a prompt response, return.
  if (session.iv && maybeResolveInteractivePrompt(session, text)) {
    return;
  }

  // Handle native button responses (supports both legacy `true` and structured `{ selected_values }` formats)
  const buttonResponse = event.content[`${MATRIX_EVENT_NAMESPACE}.button_response`];
  if (buttonResponse) {
    const selectedValues = (typeof buttonResponse === 'object' && Array.isArray(buttonResponse.selected_values))
      ? buttonResponse.selected_values
      : null;
    // Use structured values if available, fall back to body
    const value = selectedValues ? selectedValues.join(', ') : (event.content.body || '').trim();
    // Override body-based text so the answer handler also uses structured values
    if (selectedValues) text = value;

    // Check if this is a queue action response
    if (value === 'interrupt') {
      const queued = session.queuedMessages || [];
      session.queuedMessages = null;
      stripQueueNotificationLinks(session);
      if (queued.length > 0) {
        const summary = formatQueueSummary(queued);
        if (session.sendHtml) {
          const plainMsg = `⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:\n${summary.plain}`;
          const htmlMsg = `<b>⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:</b>${summary.html}`;
          session.sendHtml(plainMsg, htmlMsg);
        } else if (session.sendCallback) {
          session.sendCallback(`⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:\n${summary.plain}`);
        }
        flushQueue(session, queued);
      }
      return;
    }

    const cancelMatch = value.match(/^cancel:(\d+)$/);
    if (cancelMatch) {
      const index = parseInt(cancelMatch[1], 10);
      const queue = session.queuedMessages;
      if (queue && index >= 0 && index < queue.length) {
        queue.splice(index, 1);
        const notifs = session.queueNotifications || [];
        if (index < notifs.length) {
          const { eventId, plain } = notifs.splice(index, 1)[0];
          if (eventId) editMessage(session.roomId, eventId, `✕ ${plain} (cancelled)`);
        }
        if (queue.length === 0) session.queuedMessages = null;
        if (session.sendCallback) {
          const remaining = queue.length;
          session.sendCallback(remaining === 0
            ? '✕ Cancelled queued message (queue empty)'
            : `✕ Cancelled queued message (${remaining} remaining)`);
        }
      }
      return;
    }

    // Otherwise treat as a question answer — fall through to waitingForAnswer handling
    // The value is already the button label, so resolveQuestionAnswer will use it as-is
  }

  // If Claude Code asked a question, handle the answer
  if (session.waitingForAnswer) {
    const q = session.pendingQuestions?.[0];
    if (q?.options?.length > 0) {
      const answer = resolveQuestionAnswer(session, text);
      const header = q.header ? `${q.header}: ` : '';
      submitAnswer(session, `${header}${answer}`);
    } else {
      submitAnswer(session, text);
    }
    return;
  }

  // Handle text "build" for plan approval
  console.log(`[PLAN-DEBUG] User message | text: "${text.slice(0, 50)}" | pendingPlan: ${!!session.pendingPlan} | busy: ${session.busy}`);
  if (text.toLowerCase().trim() === 'build' && (session.pendingPlan || session.pendingPlanDenialId || session.ivPendingPlanToolUseId)) {
    const toolUseId = session.pendingPlanDenialId;
    console.log(`[PLAN-DEBUG] Build triggered! pendingPlan=${!!session.pendingPlan} denialId=${toolUseId}`);

    // Check if a tool_result already exists in the session history for this tool_use_id.
    // Claude CLI auto-generates a tool_result for permission denials, so sending another
    // one causes a duplicate tool_result API 400 error.
    const alreadyAnswered = toolUseId && session.claudeSessionId
      ? hasToolResultInHistory(session.claudeSessionId, session.workdir, toolUseId, session.worktree)
      : false;
    console.log(`[PLAN-DEBUG] tool_result already in history: ${alreadyAnswered}`);

    if (session.iv) {
      // iv-mode: the ExitPlanMode hook is blocking on /plan-decision; resolve
      // it with allow so the hook returns and claude proceeds naturally.
      // No stdin.write or follow-up text needed — the hook's allow decision
      // unblocks the original tool call and claude continues its turn.
      const pending = session.ivPendingPlanToolUseId
        ? pendingPlanDecisions.get(session.ivPendingPlanToolUseId)
        : null;
      session.pendingPlan = null;
      session.pendingPlanDenialId = null;
      session.ivPendingPlanToolUseId = null;
      if (session.claudeSessionId) {
        persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { pendingPlanDenialId: null });
      }
      if (pending) {
        console.log(`[PLAN-DEBUG] iv-mode: resolving pending plan decision with allow`);
        pending.resolve({ decision: 'allow', reason: 'approved by user' });
      } else {
        console.log(`[PLAN-DEBUG] iv-mode: no pending plan decision found; sending build prompt as text`);
        sendTextToSession(session, 'The user has approved the plan. Go ahead and execute it now. Do not re-enter plan mode — just make the changes directly.');
      }
    } else if (!toolUseId || alreadyAnswered) {
      // No denial ID, or tool_result already exists — send as plain text to avoid duplicate
      session.pendingPlan = null;
      session.pendingPlanDenialId = null;
      if (session.claudeSessionId) {
        persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { pendingPlanDenialId: null });
      }
      console.log(`[PLAN-DEBUG] Plan approved — sending as text message${alreadyAnswered ? ' (tool_result already in history)' : ''}`);
      sendTextToSession(session, 'The user has approved the plan. Go ahead and execute it now. Do not re-enter plan mode — just make the changes directly.');
    } else {
      // No existing tool_result — send tool_result to properly exit plan mode
      session.pendingPlan = null;
      session.pendingPlanDenialId = null;
      if (session.claudeSessionId) {
        persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { pendingPlanDenialId: null });
      }
      session.busy = true;
      const jsonMsg = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              tool_use_id: toolUseId,
              type: 'tool_result',
              content: 'Plan approved by user.',
            },
            {
              type: 'text',
              text: 'Go ahead and execute the plan now.',
            }
          ]
        }
      }) + '\n';
      console.log(`[PLAN-DEBUG] Sending tool_result + text for ExitPlanMode: ${toolUseId}`);
      session.proc.stdin.write(jsonMsg);
      if (session.resetTimeout) session.resetTimeout();
      if (session.typingInterval) clearInterval(session.typingInterval);
      session.typingInterval = startTyping(session.roomId);
    }
    const buildNotice = notice('success', '▶️ Building...', '▶️ <b>Building…</b>');
    await sendHtmlFn(buildNotice.plain, buildNotice.html);
    return;
  }

  // User sent feedback on the plan (not "build") — clear plan state and forward as message.
  // Only do this when Claude is idle; if busy, leave pendingPlan so "build" still works later.
  if ((session.pendingPlan || session.pendingPlanDenialId) && !session.busy) {
    session.pendingPlan = null;
    session.pendingPlanDenialId = null;
    if (session.claudeSessionId) {
      persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { pendingPlanDenialId: null });
    }
    // Falls through to normal message handling below
  }

  // In iv-mode, claude-side slash commands (/login, /mcp, /commit, etc)
  // are TUI control commands — they belong in claude's input buffer, not
  // in the bridge's "next user prompt" queue. Bypass the busy/queue path
  // so they flow straight through to the PTY. Without this, /login
  // sits in the queue forever if the previous turn's Stop hook didn't
  // fire (e.g. for unauthenticated "Please run /login" pseudo-turns)
  // and the user can't recover without manually flushing.
  const isClaudeSlashCommand =
    session.iv && text.startsWith('/') && !text.startsWith('//');
  // Raw-keystroke rescue commands for iv-mode sessions. These work
  // regardless of busy state because they're pure recovery actions
  // (the user can always need to interrupt claude or nudge a stuck
  // input box, even when the bridge thinks claude is mid-turn).
  //
  //   !enter — send Enter into the PTY. Use when a heavy session
  //            resume + race left text sitting unsent in claude's
  //            input box.
  //   !esc   — send Esc into the PTY. Same effect as pressing Esc
  //            in the TUI: cancels the current generation/turn,
  //            dismisses the OAuth wait, exits a menu, etc.
  if (session.iv && session.iv.alive) {
    const lower = text.trim().toLowerCase();
    if (lower === '!enter') {
      try {
        session.iv.sendKeystroke('enter');
        await sendReply('↵ Sent Enter to claude. If you had text queued in the input box, it should submit now.');
      } catch (err) {
        await sendReply(`Could not send Enter: ${err.message}`);
      }
      return;
    }
    if (lower === '!esc' || lower === '!escape' || lower === '!stop') {
      try {
        session.iv.sendKeystroke('esc');
        clearBusyAfterEsc(session);
        await sendReply('⎋ Sent Esc to claude (cancels the current turn / dismisses prompts).');
      } catch (err) {
        await sendReply(`Could not send Esc: ${err.message}`);
      }
      return;
    }
  }
  if (session.busy && !isClaudeSlashCommand) {
    const lowerText = text.toLowerCase().trim();
    if (lowerText === '!esc' || lowerText === '!escape') {
      try {
        if (session.iv) {
          session.iv.sendKeystroke('esc');
        } else if (session.proc?.stdin?.writable) {
          const msg = JSON.stringify({
            type: 'control_request',
            request_id: randomUUID(),
            request: { subtype: 'interrupt' },
          }) + '\n';
          session.proc.stdin.write(msg);
        }
      } catch { /* ignore */ }
      session._interrupted = true;
      clearBusyAfterEsc(session);
      await sendReply('⎋ Interrupt sent — waiting for current turn to cancel.');
      return;
    }
    if (lowerText === 'send' || lowerText === 'interrupt' || lowerText === '!interrupt') {
      const queued = session.queuedMessages || [];
      session.queuedMessages = null;
      stripQueueNotificationLinks(session);
      if (queued.length > 0) {
        const summary = formatQueueSummary(queued);
        if (sendHtmlFn) {
          const plainMsg = `⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:\n${summary.plain}`;
          const htmlMsg = `<b>⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:</b>${summary.html}`;
          await sendHtmlFn(plainMsg, htmlMsg);
        } else {
          await sendReply(`⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:\n${summary.plain}`);
        }
        flushQueue(session, queued);
      } else {
        await sendReply('⚡ No queued messages to send.');
      }
      return;
    }
    if (lowerText === 'interrupt' || lowerText === '!interrupt' || lowerText === 'escape') {
      try {
        if (session.iv) session.iv.sendKeystroke('esc');
        else if (session.proc) session.proc.kill('SIGINT');
      } catch (e) { debug(`interrupt signal error: ${e.message}`); }
      session._interrupted = true;
      if (session.iv) clearBusyAfterEsc(session);
      await sendReply('⚡ Interrupt sent — waiting for current turn to cancel.');
      return;
    }
    if (lowerText === 'cancel') {
      const queue = session.queuedMessages || [];
      const notifs = session.queueNotifications || [];
      if (queue.length === 0) {
        await sendReply('No queued messages to cancel.');
        return;
      }
      queue.pop();
      if (notifs.length > 0) {
        const { eventId, plain } = notifs.pop();
        if (eventId) {
          await editMessage(session.roomId, eventId, `✕ ${plain} (cancelled)`);
        }
      }
      const remaining = queue.length;
      if (remaining === 0) {
        session.queuedMessages = null;
      }
      await sendReply(remaining === 0
        ? 'Cancelled queued message (queue empty).'
        : `Cancelled queued message (${remaining} remaining).`);
      return;
    }
    // Queue the message
    if (!session.queuedMessages) session.queuedMessages = [];
    if (!session.queueNotifications) session.queueNotifications = [];

    if (hasMedia) {
      try {
        const blocks = await buildMediaContentBlocks(event, session);
        session.queuedMessages.push(blocks);
      } catch (err) {
        console.error('Media queue error:', err);
        await sendReply(`Failed to process file: ${err.message}`);
        return;
      }
    } else {
      session.queuedMessages.push([{ type: 'text', text }]);
    }
    const count = session.queuedMessages.length;
    const preview = hasMedia
      ? (event.content.body || '[media]')
      : (text.length > 40 ? text.slice(0, 37) + '…' : text);
    const queueIndex = count - 1;
    const plainNotif = `📨 Queued (${count}): ${preview}`;
    if (session.sendButtonMessage) {
      const buttons = [
        { id: 'cancel', label: '✕ Cancel', value: `cancel:${queueIndex}` },
        { id: 'interrupt', label: '⚡ Send now', value: 'interrupt' },
      ];
      const htmlQueue = escapeHtml(plainNotif);
      const notifEventId = await session.sendButtonMessage(
        plainNotif, buttons, 'pick_one', plainNotif, htmlQueue
      );
      if (notifEventId) session.queueNotifications.push({ eventId: notifEventId, plain: plainNotif });
    } else {
      // Fallback to signed links (existing behavior)
      const interruptLink = generateActionLink('interrupt', roomId);
      const cancelLink = generateActionLink('cancel', roomId, { index: queueIndex });
      if (interruptLink || cancelLink) {
        const links = [];
        if (cancelLink) links.push(`<a href="${cancelLink}">✕ Cancel</a>`);
        if (interruptLink) links.push(`<a href="${interruptLink}">⚡ Send now</a>`);
        const htmlQueue = `${escapeHtml(plainNotif)}<br/>${links.join(' · ')}`;
        const notifEventId = await sendHtmlFn(plainNotif, htmlQueue);
        if (notifEventId) session.queueNotifications.push({ eventId: notifEventId, plain: plainNotif });
      } else {
        await sendReply(plainNotif);
      }
    }
    return;
  }

  // Slash-command bypass keeps the queue intact: the command is for claude's
  // PTY input, not a new turn start, so any messages queued during the
  // still-running prior turn should still flush when that turn ends.
  if (!isClaudeSlashCommand) {
    session.queuedMessages = null;
  }

  // An operator-typed `/compact` compacts and returns to the idle input box
  // WITHOUT producing an assistant turn — so no Stop hook fires and the iv
  // turn-end path (onTurnEnd) never runs to clear `busy`. The session then
  // wedges in busy=true and every later message drops into the queue. Mark
  // it here so the matching compact_boundary transcript event can stand in
  // as the turn-end signal (see case 'system' in handleClaudeEvent). The
  // flag is operator-scoped on purpose: a model-invoked /compact mid-turn is
  // also trigger='manual' but DOES continue into a real turn + Stop hook, so
  // it must not be cleared here. Self-clears after a generous window in case
  // compaction fails and no boundary event ever arrives.
  if (isClaudeSlashCommand && /^\/compact(\s|$)/.test(text.trim())) {
    session._operatorCompactPending = true;
    if (session._operatorCompactTimer) clearTimeout(session._operatorCompactTimer);
    session._operatorCompactTimer = setTimeout(() => {
      session._operatorCompactTimer = null;
      session._operatorCompactPending = false;
    }, 300_000);
    if (typeof session._operatorCompactTimer.unref === 'function') session._operatorCompactTimer.unref();
  }

  if (hasMedia) {
    try {
      // Show transcription status for voice notes
      let statusEventId = null;
      if (msgtype === 'm.audio') {
        const transcribeNotice = notice('info', 'Transcribing voice note...', 'Transcribing voice note…');
        statusEventId = await sendHtmlFn(transcribeNotice.plain, transcribeNotice.html);
      }

      const blocks = await buildMediaContentBlocks(event, session);
      if (blocks.length === 0) {
        if (statusEventId) await editMessage(roomId, statusEventId, 'Voice note transcription failed', notice('error', 'Voice note transcription failed', 'Voice note transcription failed').html);
        else await sendReply('Could not process the file.');
        return;
      }

      // Update status with transcription preview
      if (statusEventId && msgtype === 'm.audio') {
        const transcriptionBlock = blocks.find(b => b.type === 'text' && b.text.startsWith('[Voice note transcription]'));
        if (transcriptionBlock) {
          const preview = transcriptionBlock.text.replace('[Voice note transcription]: ', '');
          const doneNotice = notice('success', `Transcribed: ${preview}`, `Transcribed: ${escapeHtml(preview)}`);
          await editMessage(roomId, statusEventId, doneNotice.plain, doneNotice.html);
        }
      }

      if (!sendToSession(session, blocks)) {
        await sendReply('Session is not available. Send !start to begin a new one.');
      } else if (!session.firstMessageCaptured) {
        session.firstMessageCaptured = true;
        const sessionShort = (session.claudeSessionId || session.roomId.slice(1)).slice(0, 2);
        const fileName = event.content.body || 'file';
        const label = `${SERVER_LABEL}:${sessionShort} ${fileName.slice(0, 60)}`;
        updateRoomName(session.roomId, label);
      }
    } catch (err) {
      console.error('Media processing error:', err);
      await sendReply(`Failed to process file: ${err.message}`);
    }
  } else {
    if (!sendTextToSession(session, text)) {
      await sendReply('Session is not available. Send !start to begin a new one.');
    } else {
      // Track user message for topic summarization (full text)
      if (!session.chatHistory) session.chatHistory = [];
      session.chatHistory.push({ role: 'user', text: text });
      debug(`Added user message to chatHistory, length now: ${session.chatHistory.length}`);
      // Persist chatHistory for resume across restarts
      if (session.claudeSessionId) {
        persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { chatHistory: session.chatHistory });
      }

      if (!session.firstMessageCaptured) {
        session.firstMessageCaptured = true;
        const sessionShort = (session.claudeSessionId || session.roomId.slice(1)).slice(0, 2);

        // Generate initial 3-word name via Gemini
        if (genAI) {
          (async () => {
            try {
              const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
              const result = await model.generateContent(
                `Generate a 3-5 word title (max 34 chars) for a conversation starting with this message.\n\nMessage: ${text.slice(0, 500)}`
              );
              const title = result.response.text().trim().slice(0, 60);
              updateRoomName(session.roomId, `${SERVER_LABEL}:${sessionShort} ${title}`);
            } catch (_e) {
              // Fallback to first message if Gemini fails
              const summary = text.length > 60 ? text.slice(0, 60) + '…' : text;
              updateRoomName(session.roomId, `${SERVER_LABEL}:${sessionShort} ${summary}`);
            }
          })();
        } else {
          // No Gemini configured - use first message
          const summary = text.length > 60 ? text.slice(0, 60) + '…' : text;
          updateRoomName(session.roomId, `${SERVER_LABEL}:${sessionShort} ${summary}`);
        }
      }
    }
  }
  } catch (err) {
    console.error('[ERROR] room.message handler:', err);
  }
});

// --- Room Membership Handler ---

// Build the standard "Session started" welcome strings. Shared by the
// join-path welcome (below) and the --prompt injection path (markIvReady), so
// both render the same banner.
function buildWelcome(workdir) {
  const plain = `Session started.\nWorkdir: ${workdir}\n\nSend any message to interact with Claude Code.`;
  const html =
    `<b>Session started</b><br/>` +
    `Workdir: <code>${escapeHtml(workdir)}</code><br/><br/>` +
    `<i>Send any message to interact with Claude Code.</i>`;
  return { plain, html };
}

async function sendPendingWelcomeIfNeeded(roomId, joinedUserId) {
  const session = sessions.get(roomId);
  if (!session || !session.pendingWelcome) return;
  if (joinedUserId === botUserId) return;

  // Mark as sent before sending to avoid duplicate notices if both room.join
  // and the membership state event arrive.
  session.pendingWelcome = false;

  // Let the crypto room tracker process the join before sharing the room key.
  await new Promise(r => setTimeout(r, 500));

  const { plain: welcomePlain, html: welcomeHtml } = buildWelcome(session.workdir);

  // Wrap the welcome send so a transient failure can't strand the queued prompt
  // below (pendingWelcome is already false, so this handler won't run again).
  if (session.sendHtml) {
    try { await session.sendHtml(welcomePlain, welcomeHtml); }
    catch (e) { debug(`[IV] welcome send failed: ${e.message}`); }
  }

  // --prompt dispatch: now that the operator has joined and keys are shared, fire
  // the queued prompt as their first message. Deliver ONLY when the TUI is ready,
  // so it writes straight to the PTY rather than into the single-slot ivPendingInput
  // stash (which a fast operator message could overwrite). Echo/persist happen only
  // after a real delivery. If the TUI isn't ready yet, arm markIvReady to fire it
  // after it drains any operator input.
  if (session.pendingAutoPrompt) {
    const fireAutoPrompt = async () => {
      const promptText = session.pendingAutoPrompt;
      if (!promptText) return;
      session.pendingAutoPrompt = null;
      // Operator-override: if the operator already sent a first message (set whether
      // it was delivered or stashed), it wins — skip the auto-prompt entirely rather
      // than deliver a second message back-to-back (which the paste→delayed-Enter
      // model could merge/reorder). Their message is already in the room + the PTY.
      if (session.firstMessageCaptured) return;
      if (sendToSession(session, [{ type: 'text', text: promptText }]) === false) {
        if (session.sendCallback) session.sendCallback('⚠️ Queued prompt could not be delivered — the session is unavailable. Send it manually.');
        return;
      }
      // The room is encrypted and the operator is present, so echoing the prompt
      // for transcript context is fine. Only after a confirmed (non-stashed) write.
      if (session.sendHtml) {
        try { await session.sendHtml(`> ${promptText}`, `<blockquote>${escapeHtml(promptText)}</blockquote>`); }
        catch (e) { debug(`[IV] prompt echo failed: ${e.message}`); }
      }
      if (!session.chatHistory) session.chatHistory = [];
      session.chatHistory.push({ role: 'user', text: promptText });
      if (session.claudeSessionId) {
        persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { chatHistory: session.chatHistory });
      }
      if (!session.firstMessageCaptured) {
        session.firstMessageCaptured = true;
        // Name from the non-secret worktree slug (no Gemini call on prompt content).
        const short = (session.claudeSessionId || session.roomId.slice(1)).slice(0, 2);
        if (session.worktree) updateRoomName(session.roomId, `${SERVER_LABEL}:${short} ${session.worktree}`);
      }
    };
    if (session.ivReady) await fireAutoPrompt();
    else session._fireAutoPromptWhenReady = fireAutoPrompt;
  }
}

client.on('room.join', async (roomId, event) => {
  try {
    await sendPendingWelcomeIfNeeded(roomId, event.state_key || event.sender);
  } catch (err) {
    console.error('[ERROR] room.join handler:', err);
  }
});

client.on('room.event', async (roomId, event) => {
  try {
    if (event.type !== 'm.room.member') return;
    if (event.content?.membership !== 'join') return;
    await sendPendingWelcomeIfNeeded(roomId, event.state_key || event.sender);
  } catch (err) {
    console.error('[ERROR] room.event membership handler:', err);
  }
});

// --- MCP Question Store ---

const pendingMcpQuestions = new Map();
let mcpQuestionCounter = 0;
const pendingSecrets = new Map();

// How long an MCP ask_user question waits for an answer before the bridge
// expires it. The bridge owns this timer (set in POST /ask) so it is
// authoritative for the timeout — the MCP poller just reports the outcome.
// 30 min: humane for an operator juggling sessions, well under the ~27.8h
// Claude Code stdio MCP tool-call ceiling and the bridge's 1h idle reaper.
const ASK_USER_TIMEOUT_MS = parseInt(process.env.ASK_USER_TIMEOUT_MS || '1800000', 10);

// Ordering fix (PR#3): how long POST /ask waits for the transcript-tail to
// deliver this question's ask_user tool_use block (the in-order trigger to
// surface it, after the preceding explanation text has flushed) before
// surfacing anyway. The transcript path is the *correct* trigger; this timer
// is only a last-resort so a genuinely stalled tail can't hang the question.
// Set generously: under heavy parallel load the single event loop saturates
// and transcript processing can lag several seconds, so a tight window (the
// original 2s) lets the timer win the race and regress to question-before-
// explanation. 30s gives the in-order trigger ample room while still bounding
// a true stall. The [QUESTION-ORDER] log reports actual elapsed-to-surface so
// this can be tuned from real data.
const QUESTION_SURFACE_MAX_WAIT_MS = parseInt(process.env.QUESTION_SURFACE_MAX_WAIT_MS || '30000', 10);

// Bridge-owned expiry for an MCP ask_user question. Fired by the timer set in
// POST /ask when the answer window elapses with no reply. Clears the session's
// waiting state, stops the typing indicator, and tells the user the question
// expired (a later reply then routes as a normal message). The pending entry
// is kept (marked expired) so the MCP poller's next GET learns the outcome and
// returns the timeout text; that GET deletes the entry.
function expireMcpQuestion(questionId) {
  const q = pendingMcpQuestions.get(questionId);
  if (!q || q.answered || q.expired) return;
  q.expired = true;
  const session = sessions.get(q.roomId);
  if (session && session.waitingForAnswer === `mcp:${questionId}`) {
    session.waitingForAnswer = null;
    session.pendingQuestions = null;
    session.currentQuestionIndex = 0;
    session.questionAnswers = [];
    if (session.typingInterval) {
      clearInterval(session.typingInterval);
      session.typingInterval = null;
      client.setTyping(session.roomId, false, 1000).catch(() => {});
    }
    const notice = '⏳ That question timed out, so I moved on. Reply any time and I will pick up your answer as a new message.';
    if (session.sendHtml) session.sendHtml(notice, escapeHtml(notice));
    else if (session.sendCallback) session.sendCallback(notice);
  }
  // Tombstone: the entry is normally dropped by the poller's next GET (which
  // observes `expired`). If that GET never arrives — poller crashed, was
  // cancelled, or lost its connection — delete it after a short window so
  // expired entries can't accumulate in pendingMcpQuestions.
  const tombstone = setTimeout(() => pendingMcpQuestions.delete(questionId), 60000);
  if (tombstone.unref) tombstone.unref();
}
const pendingSensitiveData = new Map(); // Map<sensitiveId, { label, content, viewed, expiresAt }>

// Map<tool_use_id, { resolve(decision), plan }> — open ExitPlanMode hook
// requests waiting for a user decision in interactive mode. The hook script
// (hooks/exit-plan-decision.sh) holds an HTTP request open against
// /plan-decision; the bridge resolves it once the user replies on Matrix.
// Phase 4 wires the session-side handler that actually surfaces the plan.
const pendingPlanDecisions = new Map();

// --- Local HTTP API ---

const API_PORT = parseInt(process.env.MATRIX_BRIDGE_API_PORT || '9802', 10);

const apiServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${API_PORT}`);

  // GET /ask/:id — MCP server polls for answer
  if (req.method === 'GET' && url.pathname.startsWith('/ask/')) {
    const questionId = url.pathname.split('/')[2];
    const q = pendingMcpQuestions.get(questionId);
    if (!q) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Question not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ answered: q.answered, answer: q.answer || null, expired: q.expired || false }));
    // Terminal states (answered or bridge-expired): cancel the expiry timer
    // and drop the entry now that the poller has observed the outcome.
    if (q.answered || q.expired) {
      if (q.expiryTimer) clearTimeout(q.expiryTimer);
      pendingMcpQuestions.delete(questionId);
    }
    return;
  }

  // GET /secret/:id — MCP server polls for secret submission
  if (req.method === 'GET' && url.pathname.startsWith('/secret/')) {
    const secretId = url.pathname.split('/')[2];
    const s = pendingSecrets.get(secretId);
    if (!s) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Secret request not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ answered: s.answered, path: s.path || null }));
    if (s.answered) {
      pendingSecrets.delete(secretId);
    }
    return;
  }

  // GET /sensitive/:id — Viewer retrieves sensitive data (one-time view)
  if (req.method === 'GET' && url.pathname.startsWith('/sensitive/')) {
    const sensitiveId = url.pathname.split('/')[2];
    const s = pendingSensitiveData.get(sensitiveId);
    if (!s) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Sensitive data not found or already viewed' }));
      return;
    }
    if (Date.now() > s.expiresAt) {
      pendingSensitiveData.delete(sensitiveId);
      res.writeHead(410);
      res.end(JSON.stringify({ error: 'Sensitive data has expired' }));
      return;
    }
    if (s.viewed) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Sensitive data has already been viewed (one-time link)' }));
      return;
    }

    // Mark as viewed and return content
    s.viewed = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ label: s.label, content: s.content }));

    // Delete after 1 minute to allow time for the page to render, but prevent repeated access
    setTimeout(() => {
      pendingSensitiveData.delete(sensitiveId);
      debug(`Cleaned up viewed sensitive data: ${sensitiveId}`);
    }, 60000);
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);

      // POST /ask — MCP server posts a question
      if (url.pathname === '/ask') {
        const { question, header, options, multiSelect, roomId } = data;
        if (!question || !roomId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'question and roomId are required' }));
          return;
        }

        const questionId = String(++mcpQuestionCounter);

        const expiryTimer = setTimeout(() => expireMcpQuestion(questionId), ASK_USER_TIMEOUT_MS);
        if (expiryTimer.unref) expiryTimer.unref();
        pendingMcpQuestions.set(questionId, {
          question, header, options, roomId,
          answered: false, answer: null,
          expired: false, expiryTimer,
        });

        const activeSession = sessions.get(roomId);

        if (activeSession) {
          const parsed = {
            questions: [{
              question,
              header: header || null,
              options: options || [],
              multiSelect: multiSelect || false,
            }]
          };

          // Ordering fix (PR#3): the MCP question reaches us via this fast,
          // direct HTTP path, while the explanation Claude emitted just BEFORE
          // the ask_user call arrives later through the slower transcript-tail.
          // Surfacing now renders the question ahead of its own explanation —
          // and because surfacing sets waitingForAnswer (which gates text
          // flushing) the explanation is then held until the user answers, so
          // it lands AFTER the answer. Instead, DEFER: the transcript handler
          // fires surface() the instant it processes this question's ask_user
          // tool_use block, which is right after the preceding text has flushed
          // (handleClaudeEvent flushes text before the tool_use loop). The
          // timeout is the safety net if that transcript event never arrives.
          const armedAt = Date.now();
          const surfaceState = { surfaced: false, timer: null };
          const surface = (source) => {
            if (surfaceState.surfaced) return;
            surfaceState.surfaced = true;
            if (surfaceState.timer) { clearTimeout(surfaceState.timer); surfaceState.timer = null; }
            if (activeSession._pendingQuestionSurface === surfaceState) {
              activeSession._pendingQuestionSurface = null;
            }
            // Diagnostic: which path surfaced the question and how long it took.
            // via=trigger = correct (transcript caught up); via=timer = the tail
            // lagged past the window and we surfaced anyway (risks ordering).
            console.log(`[QUESTION-ORDER] surface via=${source} elapsed=${Date.now() - armedAt}ms room=${activeSession.roomId.slice(1, 7)} q=${questionId}`);
            if (activeSession.typingInterval) {
              clearInterval(activeSession.typingInterval);
              activeSession.typingInterval = null;
            }
            // Flush any explanation text that has streamed in ahead of the
            // question so it renders FIRST even on the timer path (best effort:
            // only helps if the tail has at least partially caught up).
            if (activeSession.responseBuffer && activeSession.responseBuffer.trim() && !activeSession.waitingForAnswer) {
              flushResponse(activeSession);
            }
            activeSession.waitingForAnswer = `mcp:${questionId}`;
            activeSession.pendingQuestions = parsed.questions;
            activeSession.currentQuestionIndex = 0;
            activeSession.questionAnswers = [];
            activeSession.responseBuffer = '';
            if (activeSession.sendCallback) {
              sendAllQuestions(activeSession);
            }
          };
          surfaceState.surface = surface;
          activeSession._pendingQuestionSurface = surfaceState;
          surfaceState.timer = setTimeout(() => surface('timer'), QUESTION_SURFACE_MAX_WAIT_MS);
          if (surfaceState.timer.unref) surfaceState.timer.unref();
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ questionId, timeoutMs: ASK_USER_TIMEOUT_MS }));
        return;
      }

      if (url.pathname === '/secret') {
        const { label, roomId } = data;
        if (!label || !roomId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'label and roomId are required' }));
          return;
        }

        const secretId = randomUUID();

        pendingSecrets.set(secretId, {
          label,
          answered: false,
          path: null,
        });

        const activeSession = sessions.get(roomId);

        if (activeSession) {
          const link = generateSecretLink(secretId, label, activeSession.roomId);
          if (link && activeSession.sendHtml) {
            const plain = `🔐 Secret requested: ${label} — Enter secret: ${link}`;
            const html = `🔐 Secret requested: <b>${escapeHtml(label)}</b> — <a href="${link}">Enter secret</a>`;
            activeSession.sendHtml(plain, html);
          } else if (activeSession.sendCallback) {
            activeSession.sendCallback(`🔐 Secret requested: ${label} (viewer not configured)`);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ secretId }));
        return;
      }

      const secretSubmitMatch = url.pathname.match(/^\/secret\/([^/]+)\/submit$/);
      if (secretSubmitMatch) {
        const secretId = secretSubmitMatch[1];
        const s = pendingSecrets.get(secretId);
        if (!s) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Secret request not found or already submitted' }));
          return;
        }

        const { value } = data;
        if (!value) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'value is required' }));
          return;
        }

        // Write secret to file
        const filePath = path.join(SECRETS_DIR, `${secretId}.txt`);
        try {
          fs.writeFileSync(filePath, value, { mode: 0o600 });
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: `Failed to write secret: ${err.message}` }));
          return;
        }

        s.answered = true;
        s.path = filePath;

        // Schedule cleanup after 1 hour
        setTimeout(() => {
          fs.unlink(filePath, () => {});
        }, SECRET_TTL_MS);

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, path: filePath }));
        return;
      }

      if (url.pathname === '/share-sensitive') {
        const { label, content, ttl, roomId } = data;
        if (!label || !content || !roomId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'label, content, and roomId are required' }));
          return;
        }

        const sensitiveId = randomUUID();
        const ttlSeconds = Math.min(Math.max(ttl || 3600, 60), 86400); // Min 1 min, max 24 hours, default 1 hour
        const expiresAt = Date.now() + ttlSeconds * 1000;

        // Generate secure link before storing data — if viewer is misconfigured, don't leak sensitive content in memory
        const link = generateSensitiveLink(sensitiveId, label, ttlSeconds);
        if (!link) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Viewer not configured (missing HMAC_SECRET or VIEWER_BASE_URL)' }));
          return;
        }

        pendingSensitiveData.set(sensitiveId, {
          label,
          content,
          viewed: false,
          expiresAt,
        });

        // Send notification to user in Matrix chat
        const activeSession = sessions.get(roomId);

        if (activeSession && activeSession.sendHtml) {
          const plain = `🔐 Secure data: ${label} — View: ${link}`;
          const html = `🔐 Secure data: <b>${escapeHtml(label)}</b> — <a href="${link}">View</a> (one-time link, expires at ${new Date(expiresAt).toISOString()})`;
          activeSession.sendHtml(plain, html);
        } else if (activeSession && activeSession.sendCallback) {
          activeSession.sendCallback(`🔐 Secure data: ${label} — ${link} (one-time link, expires at ${new Date(expiresAt).toISOString()})`);
        }

        // Schedule cleanup after expiry
        setTimeout(() => {
          pendingSensitiveData.delete(sensitiveId);
          debug(`Cleaned up expired sensitive data: ${sensitiveId}`);
        }, ttlSeconds * 1000);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: link, expiresAt: new Date(expiresAt).toISOString() }));
        return;
      }

      if (url.pathname === '/redact-message') {
        const { roomId, eventId, reason } = data;
        if (!roomId || !eventId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'roomId and eventId are required' }));
          return;
        }

        try {
          await client.redactEvent(roomId, eventId, reason || 'Message redacted by bridge');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          debug(`Failed to redact message: ${err.message}`);
          res.writeHead(500);
          res.end(JSON.stringify({ error: `Failed to redact message: ${err.message}` }));
        }
        return;
      }

      if (url.pathname === '/send') {
        const { roomId, message } = data;
        if (!roomId || !message) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'roomId and message required' }));
          return;
        }
        const session = sessions.get(roomId);
        if (!session || !session.alive) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No active session for this room' }));
          return;
        }
        sendTextToSession(session, message);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));

      } else if (url.pathname === '/interrupt') {
        const { roomId } = data;
        if (!roomId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'roomId required' }));
          return;
        }
        const session = sessions.get(roomId);
        if (!session || !session.alive) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No active session for this room' }));
          return;
        }
        const queued = session.queuedMessages || [];
        session.queuedMessages = null;
        stripQueueNotificationLinks(session);
        if (queued.length > 0) {
          const summary = formatQueueSummary(queued);
          if (session.sendHtml) {
            const plainMsg = `⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:\n${summary.plain}`;
            const htmlMsg = `<b>⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:</b>${summary.html}`;
            session.sendHtml(plainMsg, htmlMsg);
          } else if (session.sendCallback) {
            session.sendCallback(`⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:\n${summary.plain}`);
          }
          flushQueue(session, queued);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, flushed: queued.length }));


      } else if (url.pathname === '/cancel-queued') {
        const { roomId, index } = data;
        if (!roomId || typeof index !== 'number') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'roomId and index required' }));
          return;
        }
        const session = sessions.get(roomId);
        if (!session || !session.alive) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No active session for this room' }));
          return;
        }
        const queue = session.queuedMessages;
        if (!queue || index < 0 || index >= queue.length) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No queued message at that index' }));
          return;
        }
        queue.splice(index, 1);
        // Edit the notification for this index to remove links
        const notifs = session.queueNotifications || [];
        if (index < notifs.length) {
          const { eventId, plain } = notifs.splice(index, 1)[0];
          if (eventId) {
            editMessage(session.roomId, eventId, `✕ ${plain} (cancelled)`);
          }
        }
        const remaining = queue.length;
        if (remaining === 0) session.queuedMessages = null;
        if (session.sendCallback) {
          const msg = remaining === 0
            ? '✕ Cancelled queued message (queue empty)'
            : `✕ Cancelled queued message (${remaining} remaining)`;
          session.sendCallback(msg);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, remaining }));

      } else if (url.pathname === '/message') {
        const { roomId, text } = data;
        if (!roomId || !text) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'roomId and text required' }));
          return;
        }
        sendToRoom(roomId, plainTextFormat(text), markdownToHtml(text)).then(() => {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        }).catch(err => {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        });

      } else if (url.pathname === '/compact-start') {
        // PreCompact hook notifies us that compaction is about to begin
        const { session_id } = data;
        let target = null;
        if (session_id) {
          for (const [, s] of sessions) {
            if (s.claudeSessionId === session_id && s.alive) { target = s; break; }
          }
        }
        if (target) {
          // Cooldown: don't send compaction messages more than once per 60s
          const now = Date.now();
          const COMPACT_COOLDOWN_MS = 60_000;
          if (!target.lastCompactStartNotify || (now - target.lastCompactStartNotify) > COMPACT_COOLDOWN_MS) {
            target.lastCompactStartNotify = now;
            if (target.sendHtml) {
              const n = notice('info', '🗜️ Compacting context — summarizing conversation history…');
              target.sendHtml(n.plain, n.html);
            } else if (target.sendCallback) {
              target.sendCallback('🗜️ Compacting context — summarizing conversation history…');
            }
          } else {
            debug('Suppressed compaction start notice (cooldown, last=%dms ago)', now - target.lastCompactStartNotify);
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));

      } else if (url.pathname === '/turn-end') {
        // Stop hook (hooks/stop-notify.sh) — fires when an assistant turn
        // completes. Used in interactive mode to clear typing indicators and
        // flush response state in lieu of the stream-json `result` event.
        const { session_id } = data;
        debug(`[IV] /turn-end hit, session_id=${session_id}`);
        let target = null;
        if (session_id) {
          for (const [, s] of sessions) {
            if (s.claudeSessionId === session_id && s.alive) { target = s; break; }
          }
        }
        debug(`[IV] /turn-end target found=${!!target} buf="${target?.responseBuffer?.slice(0,60) || ''}"`);
        if (target) {
          // Drain the transcript tail synchronously so any assistant event
          // written just before the Stop hook is processed (and the
          // response buffer populated) before onTurnEnd flushes.
          if (target.iv && typeof target.iv.drainTranscript === 'function') {
            try { target.iv.drainTranscript(); } catch (e) { debug('drainTranscript threw:', e?.message); }
          }
          if (typeof target.onTurnEnd === 'function') {
            try { target.onTurnEnd(); } catch (e) { debug('onTurnEnd handler threw:', e?.message); }
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));

      } else if (url.pathname === '/plan-decision') {
        // PreToolUse hook (hooks/exit-plan-decision.sh) — fires when claude
        // calls ExitPlanMode. Blocks until the user decides via Matrix.
        const { session_id, tool_use_id, plan } = data;
        if (!tool_use_id) {
          res.writeHead(400);
          res.end(JSON.stringify({ decision: 'deny', reason: 'tool_use_id required' }));
          return;
        }
        let target = null;
        if (session_id) {
          for (const [, s] of sessions) {
            if (s.claudeSessionId === session_id && s.alive) { target = s; break; }
          }
        }
        if (!target) {
          res.writeHead(404);
          res.end(JSON.stringify({ decision: 'deny', reason: 'unknown session' }));
          return;
        }
        if (typeof target.requestPlanDecision !== 'function') {
          // Session has no plan-decision handler — this is the print-mode path
          // (Phase 4 adds the iv-mode handler). Deny so we never silently
          // execute an unreviewed plan.
          res.writeHead(503);
          res.end(JSON.stringify({ decision: 'deny', reason: 'no plan-decision handler for session' }));
          return;
        }
        // Hold the response. Timer caps the wait under curl's 1800s ceiling
        // in exit-plan-decision.sh so we always reply before curl times out.
        const PLAN_DECISION_TIMEOUT_MS = 1740 * 1000;
        const timer = setTimeout(() => {
          if (!pendingPlanDecisions.has(tool_use_id)) return;
          pendingPlanDecisions.delete(tool_use_id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ decision: 'deny', reason: 'timeout waiting for user' }));
        }, PLAN_DECISION_TIMEOUT_MS);
        pendingPlanDecisions.set(tool_use_id, {
          resolve: ({ decision, reason }) => {
            clearTimeout(timer);
            pendingPlanDecisions.delete(tool_use_id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ decision: decision || 'deny', reason: reason || '' }));
          },
          plan,
        });
        try {
          target.requestPlanDecision(tool_use_id, plan);
        } catch (e) {
          // If the handler throws, resolve with deny so the hook unblocks.
          const pending = pendingPlanDecisions.get(tool_use_id);
          if (pending) pending.resolve({ decision: 'deny', reason: `session handler threw: ${e?.message || e}` });
        }

      } else if (url.pathname === '/sessions') {
        const list = [];
        for (const [roomId, session] of sessions) {
          list.push({
            roomId,
            alive: session.alive,
            busy: session.busy,
            workdir: session.workdir,
            claudeSessionId: session.claudeSessionId,
            uptime: Math.round((Date.now() - session.startedAt) / 1000),
          });
        }
        res.writeHead(200);
        res.end(JSON.stringify(list));

      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    } catch (_e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
  });
});

apiServer.listen(API_PORT, '127.0.0.1', () => {
  console.log(`Local API listening on 127.0.0.1:${API_PORT}`);
});

function killSession(session, signal = 'SIGTERM') {
  if (!session) return;
  if (session._enterRetryTimer) { clearTimeout(session._enterRetryTimer); session._enterRetryTimer = null; }
  if (session._escBusyTimer) { clearTimeout(session._escBusyTimer); session._escBusyTimer = null; }
  // Stop the subagent watcher up-front so its tails and burst timer don't
  // keep running if the child ignores SIGTERM. The close handler also
  // stops it, but belt-and-braces.
  if (session.subagentWatcher) {
    session.subagentWatcher.stop().catch(() => {});
    session.subagentWatcher = null;
  }
  // Drop any pending MCP questions for this room — the MCP server that
  // owns them died with the session, so the entries would otherwise leak.
  for (const [qid, entry] of pendingMcpQuestions) {
    if (entry.roomId === session.roomId) pendingMcpQuestions.delete(qid);
  }
  if (!session.alive) return;
  try {
    if (session.iv) session.iv.kill(signal);
    else if (session.proc) session.proc.kill(signal);
  } catch (e) {
    debug(`killSession error: ${e.message}`);
  }
}

function startIdleReaper() {
  setInterval(() => {
    const now = Date.now();
    for (const [roomId, session] of sessions) {
      if (!session.alive) continue;
      if (session._autoStopped) continue;
      const last = session.lastActivityAt || session.startedAt || 0;
      if (now - last < SESSION_IDLE_TIMEOUT_MS) continue;

      // Silent reap — posting a Matrix notice would bump the room to the top
      // of the user's room list, defeating the purpose. The session is
      // resumable on the next user message via the existing auto-resume path.
      const idleHours = Math.round((now - last) / 3600000);
      debug(`Reaping idle session in ${roomId} (idle ${idleHours}h)`);
      session._autoStopped = true;
      killSession(session, 'SIGTERM');
    }
  }, SESSION_IDLE_CHECK_MS).unref();
}

// --- Startup ---

async function main() {
  // Ensure secrets directory exists with restricted permissions
  try {
    await fs.promises.mkdir(SECRETS_DIR, { mode: 0o700, recursive: true });
  } catch {}

  botUserId = await client.getUserId();
  console.log(`Bot logged in as ${botUserId}`);
  console.log(`Homeserver: ${MATRIX_HOMESERVER_URL}`);
  console.log(`Allowed users: ${ALLOWED_USER_IDS.length ? ALLOWED_USER_IDS.join(', ') : 'any'}`);
  console.log(`Default workdir: ${DEFAULT_WORKDIR}`);
  if (SESSION_IDLE_TIMEOUT_MS > 0) {
    console.log(`Session idle timeout: ${SESSION_IDLE_TIMEOUT_MS}ms (check every ${SESSION_IDLE_CHECK_MS}ms)`);
    startIdleReaper();
  } else {
    console.log('Session idle timeout: disabled');
  }
  console.log(`Session room encryption: ${ENCRYPT_SESSION_ROOMS ? 'ON' : 'OFF'}`);
  console.log(`Bridge Claude instructions: ${BRIDGE_CLAUDE_MD_PATH}`);
  console.log(`Debug mode: ${DEBUG ? 'ON' : 'OFF'}`);

  await client.start();
  console.log('Matrix client started, listening for messages...');

  // Ensure all joined rooms have the Matron command state event (only if changed)
  try {
    const rooms = await client.getJoinedRooms();
    const newCommandsJson = JSON.stringify({ commands: MATRON_COMMANDS });
    let updated = 0;
    for (const roomId of rooms) {
      for (const eventType of COMMAND_EVENT_TYPES) {
        try {
          const existing = await client.getRoomStateEvent(roomId, eventType, '');
          if (JSON.stringify(existing) === newCommandsJson) continue;
        } catch { /* state event doesn't exist yet */ }
        try {
          await client.sendStateEvent(roomId, eventType, '', { commands: MATRON_COMMANDS });
          updated++;
        } catch (e) {
          debug(`Could not set commands state ${eventType} in ${roomId}: ${e.message}`);
        }
      }
    }
    console.log(`Checked command state events in ${rooms.length} rooms (updated ${updated})`);
  } catch (e) {
    console.error('Failed to update command state events:', e.message);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  saveLastEventTsMap();
  for (const [, session] of sessions) {
    killSession(session);
  }
  client.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveLastEventTsMap();
  for (const [, session] of sessions) {
    killSession(session);
  }
  client.stop();
  process.exit(0);
});
