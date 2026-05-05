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
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT || '3600000', 10);
const MAX_MSG_LENGTH = 32768;  // Matrix supports ~65KB, use 32K as practical limit
const DEBUG = process.env.DEBUG === '1';
const ENCRYPT_SESSION_ROOMS = process.env.ENCRYPT_SESSION_ROOMS !== '0';
const MATRIX_EVENT_NAMESPACE = 'com.matron';
const LEGACY_MATRIX_EVENT_NAMESPACE = 'com.yearbook';
const COMMAND_EVENT_TYPES = [
  `${MATRIX_EVENT_NAMESPACE}.commands`,
  `${LEGACY_MATRIX_EVENT_NAMESPACE}.commands`,
];
const SESSIONS_FILE = path.join(os.homedir(), '.claude-matrix-sessions.json');

// Generate MCP config with resolved paths (--mcp-config requires a file, not inline JSON)
const MCP_CONFIG_PATH = path.join(__dirname, '.mcp-config-generated.json');
const mcpConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'mcp-config.json'), 'utf-8'));
mcpConfig.mcpServers['ask-user'].args[0] = path.join(__dirname, 'ask-user.js');
fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(mcpConfig, null, 2));
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH || path.join(os.homedir(), '.local/share/whisper-cpp/models/ggml-small.bin');
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || 'en';

// Server label for room names: "dev-3" → "3", fallback to SERVER_LABEL env var
const SERVER_LABEL = process.env.SERVER_LABEL || (() => {
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
const _rawLiveOutputTtl = parseInt(process.env.MATRON_LIVE_OUTPUT_TTL || '14400', 10);
const LIVE_OUTPUT_TTL = Number.isFinite(_rawLiveOutputTtl) && _rawLiveOutputTtl > 0 ? _rawLiveOutputTtl : 14400;
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
  data[String(roomId)] = { ...existing, sessionId, workdir, lastUsed: Date.now(), originRoomId: originRoomId || null, ...(extra || {}) };
  savePersistedSessions(data);
}

function getPersistedSession(roomId) {
  const data = loadPersistedSessions();
  return data[String(roomId)] || null;
}

// --- Session Manager ---

const sessions = new Map(); // roomId -> session

function createSession(roomId, workdir, resumeSessionId) {
  const cwd = expandHome(workdir || DEFAULT_WORKDIR);
  // Per-room live-bash-output gate. Defaults on; toggled via !show_bash.
  // showBashOutput is persisted via persistSession on toggle and re-read here at
  // spawn so the hook env stays in sync with the room's setting across restarts.
  // Unset (undefined) means "never toggled" → use the default (on).
  const persistedForRoom = getPersistedSession(roomId);
  const showBashOutputAtSpawn = persistedForRoom?.showBashOutput !== false;
  const args = [
    '--print',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--disallowed-tools', 'AskUserQuestion',
    '--append-system-prompt', BRIDGE_SYSTEM_PROMPT,
    '--include-partial-messages',
    '--mcp-config', MCP_CONFIG_PATH,
    '--settings', JSON.stringify({
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

  debug(`Spawning claude with args: ${args.join(' ')}`);
  debug(`Working directory: ${cwd}`);

  const proc = spawn('claude', args, {
    cwd,
    env: {
      ...process.env,
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
    responseBuffer: '',
    sendCallback: null,
    pendingPlan: null,
    pendingPlanDenialId: resumeSessionId ? (getPersistedSession(roomId)?.pendingPlanDenialId || null) : null,
    sendHtml: null,
    showWorking: false,
    showBashOutput: showBashOutputAtSpawn,
    alive: true,
    startedAt: Date.now(),
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

    // Flush any remaining response
    flushResponse(session);

    if (sessions.get(roomId) === session) {
      if (exitCode !== 0 && session.restartCount < 3 && !session._resumeFailed) {
        const restarted = createSession(roomId, cwd, session.claudeSessionId);
        restarted.restartCount = session.restartCount + 1;
        restarted.sendCallback = session.sendCallback;
        restarted.sendHtml = session.sendHtml;
        restarted.sendButtonMessage = session.sendButtonMessage;
        restarted.originRoomId = session.originRoomId;
        restarted.firstMessageCaptured = session.firstMessageCaptured;
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

  sessions.set(roomId, session);
  return session;
}

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
    msg += '\n';
    q.options.forEach((opt, i) => {
      const letter = String.fromCharCode(65 + i); // A, B, C...
      const label = opt.label || opt;
      const desc = opt.description || '';
      msg += `${letter}. ${typeof label === 'string' ? label : String(label)}\n`;
      if (desc) {
        msg += `   ${desc}\n`;
      }
    });
    msg += `\nReply with a letter (A, B, C…) or number (1, 2, 3…), or type a custom answer.`;
  }

  return msg;
}

function formatQuestionHtml(q, index, total) {
  let msg = '';
  const prefix = total > 1 ? `❓ Question ${index + 1}/${total}` : '❓';

  if (q.header) {
    msg += `${prefix} — <b>${escapeHtml(q.header)}</b>\n\n`;
  } else {
    msg += `${prefix}\n\n`;
  }

  msg += escapeHtml(q.question) + '\n';

  if (q.options && q.options.length > 0) {
    msg += '\n';
    q.options.forEach((opt, i) => {
      const letter = String.fromCharCode(65 + i);
      const label = opt.label || opt;
      const desc = opt.description || '';
      msg += `<b>${letter}.</b> ${escapeHtml(typeof label === 'string' ? label : String(label))}\n`;
      if (desc) {
        msg += `   <i>${escapeHtml(desc)}</i>\n`;
      }
    });
    msg += `\nReply with a letter (A, B, C…) or number (1, 2, 3…), or type a custom answer.`;
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
      debug(`MCP question ${questionId} answered: ${answerText}`);
    }
    // Start typing — Claude will continue once the MCP tool returns
    if (session.typingInterval) clearInterval(session.typingInterval);
    session.typingInterval = startTyping(session.roomId);
  } else if (mode === 'text-reply') {
    // AskUserQuestion was auto-rejected — send the answer as a regular user message
    sendTextToSession(session, answerText);
  } else {
    // Normal tool_result flow
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

function handleClaudeEvent(session, event) {
  // Capture session ID from any event that carries it
  if (event.session_id && !session.claudeSessionId) {
    session.claudeSessionId = event.session_id;
    persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId);
    console.log(`Captured session ID for room ${session.roomId}: ${session.claudeSessionId}`);
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
      const content = event.message?.content;
      if (!Array.isArray(content)) break;

      const isPartial = event.message?.stop_reason === null;
      const messageId = event.message?.id;

      const textParts = content.filter(b => b.type === 'text' && b.text).map(b => b.text);
      if (textParts.length > 0) {
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
      }

      for (const block of content) {
        if (block.type !== 'tool_use') continue;

        if (session.responseBuffer.trim() && !session.waitingForAnswer) {
          flushResponse(session);
        }

        const toolName = block.name;
        const input = block.input || {};

        if (toolName === 'ExitPlanMode') {
          console.log(`[PLAN-DEBUG] Tool call: ExitPlanMode | block.id: ${block.id} | input keys: ${Object.keys(input).join(',')}`);
          // Persist the tool_use_id so "build" can send a tool_result even after bridge restart
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

          if (toolName === 'Bash' && input.command) {
            // Detect matron-tee rewrite and extract the original command + log path.
            // Marker shape: <abs>/matron-tee /tmp/matron-cmd-<TUID>.log -- bash -c '<cmd>'
            const teeMatch = input.command.match(/^.*\/matron-tee (\/tmp\/matron-cmd-([^.]+)\.log) -- bash -c '(.+)'$/s);
            let displayCommand = input.command;
            let liveLogPath = null;
            let liveToolUseId = null;
            if (teeMatch) {
              liveLogPath = teeMatch[1];
              liveToolUseId = teeMatch[2];
              // Inverse of jq @sh quoting: '\''  ->  '
              displayCommand = teeMatch[3].replace(/'\\''/g, "'");
            }

            const cmd = displayCommand.length > 100
              ? displayCommand.slice(0, 100) + '…'
              : displayCommand;
            indicator = `🔧 \`${cmd}\``;
            indicatorHtml = `🔧 <code>${escapeHtml(cmd)}</code>`;
            isKeyEvent = true;

            if (liveToolUseId && session.showBashOutput) {
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
                sendLiveOutputEvent(session, {
                  tool_use_id: liveToolUseId,
                  command: displayCommand,
                  viewer_url: liveUrl.toString(),
                  expires_at: expiresAt,
                });
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
          } else if (toolName === 'Task') {
            const desc = (input.description || input.prompt || '').slice(0, 80);
            indicator = `🔀 Subtask: ${desc}`;
            indicatorHtml = `🔀 Subtask: <i>${escapeHtml(desc)}</i>`;
            isKeyEvent = true;
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

          session.toolCalls.push(indicator);

          if (isKeyEvent && session.sendHtml && indicatorHtml) {
            session.sendHtml(indicator, indicatorHtml);
          } else if (isKeyEvent && session.sendCallback) {
            session.sendCallback(indicator);
          }
        }
      }
      break;
    }

    case 'result': {
      // Handle fatal errors (e.g. failed resume with invalid session ID)
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
          break;
        }
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
}

function sendToSession(session, contentBlocks) {
  if (!session.alive) return false;

  session.responseBuffer = '';
  session.toolCalls = [];
  session.busy = true;

  if (session.typingInterval) clearInterval(session.typingInterval);
  session.typingInterval = startTyping(session.roomId);

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
    sendToSession(session, merged);
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
  const body = `$ ${command}\n[live output: ${viewer_url}]`;
  const formatted_body = `<a href="${escapeHtml(viewer_url)}"><code>$ ${escapeHtml(command)}</code> · view live output</a>`;
  const content = {
    msgtype: 'm.text',
    body,
    format: 'org.matrix.custom.html',
    formatted_body,
    [`${MATRIX_EVENT_NAMESPACE}.live_output`]: { tool_use_id, command, viewer_url, expires_at },
  };
  try {
    await client.sendEvent(session.roomId, `${MATRIX_EVENT_NAMESPACE}.live_output.v1`, content);
  } catch (e) {
    console.error('Failed to send live_output event:', e.message);
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
    // Keep deployed clients working while they migrate from the Yearbook namespace.
    [`${LEGACY_MATRIX_EVENT_NAMESPACE}.buttons`]: {
      mode,
      prompt,
      buttons,
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

  const roomId = await client.createRoom({
    preset: 'private_chat',
    name: `${SERVER_LABEL}: New session`,
    invite: [inviteUserId],
    initial_state: initialState,
  });
  debug(`Created session room ${roomId} for ${inviteUserId}`);
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
  const encodedPath = (workdir || DEFAULT_WORKDIR).replace(/\//g, '-');
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
function hasToolResultInHistory(sessionId, workdir, toolUseId) {
  const encodedPath = (workdir || DEFAULT_WORKDIR).replace(/\//g, '-');
  const filePath = path.join(os.homedir(), '.claude', 'projects', encodedPath, `${sessionId}.jsonl`);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    // Scan from end (most recent) for efficiency
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      // Quick string check before parsing JSON
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
  } else if (content.msgtype === 'm.image') {
    // Save image to workdir
    const imgPath = deduplicateFilename(session.workdir, fileName);
    fs.writeFileSync(imgPath, buffer);
    blocks.push({ type: 'text', text: `Image saved to ${imgPath}` });
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: mime, data: buffer.toString('base64') }
    });
  } else {
    // Save file to workdir
    const savePath = deduplicateFilename(session.workdir, fileName);
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

      const arg = parts[1];
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

      const session = createSession(sessionRoomId, workdir);
      session.originRoomId = roomId;
      session.sendCallback = sessionSendReply;
      session.sendHtml = sessionSendHtml;
      session.sendButtonMessage = sessionSendButtons;

      // Confirm in origin room with a link to the new room
      const roomLink = `https://matrix.to/#/${sessionRoomId}`;
      await sendReply(`Session started in new room: ${roomLink}`);

      // Welcome message will be sent when user joins (see room.join handler)
      break;
    }

    case '!stop': {
      const session = sessions.get(roomId);
      if (!session || !session.alive) {
        await sendReply('No active session.');
        return;
      }
      session.proc.kill();
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
      const restartSessionId = existing.claudeSessionId;
      const restartWorkdir = existing.workdir;
      sessions.delete(roomId);
      existing.proc.kill();
      await sendReply('🔄 Restarting session...');
      const restarted = createSession(roomId, restartWorkdir, restartSessionId);
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
      await sendReply(
        `Session restarted.\nSession: ${restartSessionId ? restartSessionId.slice(0, 8) + '...' : '(new)'}\nWorkdir: ${restartWorkdir}`
      );
      break;
    }

    case '!resume': {
      if (!sender) {
        await sendReply('Cannot determine sender. Please try again.');
        return;
      }

      const resumeArg = parts[1]?.replace(/\.+$/, '') || undefined;

      if (!resumeArg) {
        // No arg — show sessions list inline
        await handleCommand(roomId, '!sessions', sendReply, sendHtml, sender);
        return;
      }

      const currentSession = sessions.get(roomId);
      const prev = getPersistedSession(roomId);
      const resumeWorkdir = currentSession?.workdir || prev?.workdir || DEFAULT_WORKDIR;
      const encodedPath = resumeWorkdir.replace(/\//g, '-');
      const projectDir = path.join(os.homedir(), '.claude', 'projects', encodedPath);

      if (!fs.existsSync(projectDir)) {
        await sendReply(`No sessions directory found for workdir: ${resumeWorkdir}`);
        return;
      }

      const files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.replace('.jsonl', ''))
        .sort((a, b) => {
          const sa = fs.statSync(path.join(projectDir, a + '.jsonl'));
          const sb = fs.statSync(path.join(projectDir, b + '.jsonl'));
          return sb.mtimeMs - sa.mtimeMs;
        });

      let resumeSessionId;
      let actualWorkdir = resumeWorkdir;
      const num = /^\d+$/.test(resumeArg) ? parseInt(resumeArg, 10) : NaN;
      if (!isNaN(num) && num >= 1 && num <= files.length) {
        resumeSessionId = files[num - 1];
      } else {
        const match = files.find(f => f.startsWith(resumeArg));
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
            const altEncoded = foundEntry.workdir.replace(/\//g, '-');
            const altDir = path.join(os.homedir(), '.claude', 'projects', altEncoded);
            const altFile = path.join(altDir, `${foundEntry.sessionId}.jsonl`);
            if (fs.existsSync(altFile)) {
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

      const session = createSession(sessionRoomId, actualWorkdir, resumeSessionId);
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

      const newDir = parts.slice(1).join(' ');
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

      const session = createSession(sessionRoomId, resolved);
      session.originRoomId = roomId;
      session.sendCallback = sessionSendReply;
      session.sendHtml = sessionSendHtml;
      session.sendButtonMessage = sessionSendButtons;

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

    case '!status': {
      const session = sessions.get(roomId);
      if (!session || !session.alive) {
        await sendReply('No active session. Send !start to begin.');
        return;
      }
      const uptimeMs = Date.now() - session.startedAt;
      const shortId = session.claudeSessionId ? session.claudeSessionId.slice(0, 8) + '…' : '(pending)';
      const busyText = session.busy ? 'yes' : 'no';

      const plainStatus =
        `Session active\nWorkdir: ${session.workdir}\nSession ID: ${shortId}\n` +
        `Uptime: ${formatDuration(uptimeMs)}\nRestarts: ${session.restartCount}/3\nBusy: ${busyText}`;

      const busyHtml = session.busy
        ? color('● busy', '#f0883e')
        : color('● idle', '#3fb950');
      const htmlStatus =
        `<b>Session Status</b><table>` +
        `<tr><td>State</td><td>${busyHtml}</td></tr>` +
        `<tr><td>Workdir</td><td><code>${escapeHtml(session.workdir)}</code></td></tr>` +
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

      const encodedPath = workdir.replace(/\//g, '-');
      const projectDir = path.join(os.homedir(), '.claude', 'projects', encodedPath);

      if (!fs.existsSync(projectDir)) {
        await sendReply('No sessions found for this workdir.');
        break;
      }

      const files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const sessionId = f.replace('.jsonl', '');
          const filePath = path.join(projectDir, f);
          const stat = fs.statSync(filePath);
          const summary = getSessionSummary(sessionId, workdir);
          return { sessionId, modified: stat.mtimeMs, summary };
        })
        .sort((a, b) => b.modified - a.modified);

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
        `Available commands:\n\n` +
        `/start — Start a new session (creates a new room)\n` +
        `/start <workdir> — Start in a specific directory\n` +
        `/stop — Stop the current session\n` +
        `/restart — Stop and immediately resume the session\n` +
        `/resume <n> — Resume session #n from /sessions list\n` +
        `/resume <id> — Resume session by ID prefix\n` +
        `/sessions — List all past sessions\n` +
        `/workdir <path> — Start session in a different directory\n` +
        `/status — Show current session info\n` +
        `/working — Toggle tool call visibility\n` +
        `/mcp — Show MCP server status\n` +
        `/model — Show current model\n` +
        `/cost — Show session cost\n` +
        `/usage — Show token usage\n` +
        `/tools — List available tools\n` +
        `/help — Show this help message\n\n` +
        `Each /start, /resume, and /workdir creates a new ${ENCRYPT_SESSION_ROOMS ? 'encrypted ' : ''}room for the session.\n` +
        `Room names show the server (${SERVER_LABEL}) and first message summary.\n\n` +
        `While Claude is working:\n` +
        `  Messages are queued automatically\n` +
        `  Send "interrupt" to force interrupt\n\n` +
        `Send any other text to chat with Claude Code.\n` +
        `You can also send photos and documents (PDFs, images, text files).`;

      const cmdGroup = (title, cmds) => {
        const items = cmds.map(([c, d]) => `<li><code>${c}</code> — ${d}</li>`).join('');
        return `<b>${title}</b><ul>${items}</ul>`;
      };

      const htmlHelp =
        cmdGroup('Sessions', [
          ['/start', 'Start a new session (creates a new room)'],
          ['/start &lt;workdir&gt;', 'Start in a specific directory'],
          ['/stop', 'Stop the current session'],
          ['/restart', 'Stop and immediately resume the session'],
          ['/resume &lt;n&gt;', 'Resume session #n from /sessions list'],
          ['/resume &lt;id&gt;', 'Resume session by ID prefix'],
          ['/sessions', 'List all past sessions'],
          ['/workdir &lt;path&gt;', 'Start session in a different directory'],
        ]) +
        cmdGroup('Info', [
          ['/status', 'Show current session info'],
          ['/working', 'Toggle tool call visibility'],
          ['/mcp', 'Show MCP server status'],
          ['/model', 'Show current model'],
          ['/cost', 'Show session cost'],
          ['/usage', 'Show token usage'],
          ['/tools', 'List available tools'],
          ['/help', 'Show this help message'],
        ]) +
        `<b>Tips</b><ul>` +
        `<li>Each <code>/start</code>, <code>/resume</code>, and <code>/workdir</code> creates a new ${ENCRYPT_SESSION_ROOMS ? 'encrypted ' : ''}room</li>` +
        `<li>Room names show the server (<code>${SERVER_LABEL}</code>) and first message summary</li>` +
        `<li>Messages are queued automatically while Claude is working</li>` +
        `<li>Send <code>interrupt</code> to force interrupt</li>` +
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
  if (!isAllowed(sender)) return;

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

  console.log(
    `Message from ${sender} in ${roomId}: ${text.slice(0, 50)}${hasMedia ? ' [media]' : ''}`
  );

  const sendReply = (reply) => sendToRoom(roomId, plainTextFormat(reply), markdownToHtml(reply));
  const sendHtmlFn = (plainText, html) => sendToRoom(roomId, plainText, html);

  // Bridge commands use / or ! prefix
  if (text.startsWith('!') || text.startsWith('/')) {
    const bridgeCommandNames = new Set([
      'start', 'stop', 'restart', 'resume', 'workdir', 'status',
      'show', 'show_working', 'working', 'sessions', 'help',
      'mcp', 'model', 'cost', 'usage', 'tools',
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

  // Handle native button responses (supports both legacy `true` and structured `{ selected_values }` formats)
  const buttonResponse = event.content[`${MATRIX_EVENT_NAMESPACE}.button_response`]
    || event.content[`${LEGACY_MATRIX_EVENT_NAMESPACE}.button_response`];
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
  if (text.toLowerCase().trim() === 'build' && (session.pendingPlan || session.pendingPlanDenialId)) {
    const toolUseId = session.pendingPlanDenialId;
    console.log(`[PLAN-DEBUG] Build triggered! pendingPlan=${!!session.pendingPlan} denialId=${toolUseId}`);

    // Check if a tool_result already exists in the session history for this tool_use_id.
    // Claude CLI auto-generates a tool_result for permission denials, so sending another
    // one causes a duplicate tool_result API 400 error.
    const alreadyAnswered = toolUseId && session.claudeSessionId
      ? hasToolResultInHistory(session.claudeSessionId, session.workdir, toolUseId)
      : false;
    console.log(`[PLAN-DEBUG] tool_result already in history: ${alreadyAnswered}`);

    if (!toolUseId || alreadyAnswered) {
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

  // Queue/interrupt logic when Claude is busy
  if (session.busy) {
    const lowerText = text.toLowerCase().trim();
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

  session.queuedMessages = null;

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

async function sendPendingWelcomeIfNeeded(roomId, joinedUserId) {
  const session = sessions.get(roomId);
  if (!session || !session.pendingWelcome) return;
  if (joinedUserId === botUserId) return;

  // Mark as sent before sending to avoid duplicate notices if both room.join
  // and the membership state event arrive.
  session.pendingWelcome = false;

  // Let the crypto room tracker process the join before sharing the room key.
  await new Promise(r => setTimeout(r, 500));

  const workdir = session.workdir;
  const welcomePlain = `Session started.\nWorkdir: ${workdir}\n\nSend any message to interact with Claude Code.`;
  const welcomeHtml =
    `<b>Session started</b><br/>` +
    `Workdir: <code>${escapeHtml(workdir)}</code><br/><br/>` +
    `<i>Send any message to interact with Claude Code.</i>`;

  if (session.sendHtml) {
    await session.sendHtml(welcomePlain, welcomeHtml);
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
const pendingSensitiveData = new Map(); // Map<sensitiveId, { label, content, viewed, expiresAt }>

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
    res.end(JSON.stringify({ answered: q.answered, answer: q.answer || null }));
    if (q.answered) {
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

        pendingMcpQuestions.set(questionId, {
          question, header, options,
          answered: false, answer: null,
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

          if (activeSession.typingInterval) {
            clearInterval(activeSession.typingInterval);
            activeSession.typingInterval = null;
          }

          activeSession.waitingForAnswer = `mcp:${questionId}`;
          activeSession.pendingQuestions = parsed.questions;
          activeSession.currentQuestionIndex = 0;
          activeSession.questionAnswers = [];
          activeSession.responseBuffer = '';

          if (activeSession.sendCallback) {
            sendAllQuestions(activeSession);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ questionId }));
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
  console.log(`Session timeout: ${SESSION_TIMEOUT}ms`);
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

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  saveLastEventTsMap();
  for (const [, session] of sessions) {
    if (session.alive) session.proc.kill();
  }
  client.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveLastEventTsMap();
  for (const [, session] of sessions) {
    if (session.alive) session.proc.kill();
  }
  client.stop();
  process.exit(0);
});
