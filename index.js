import dotenv from 'dotenv';
dotenv.config({ override: true });
import { MatrixClient, SimpleFsStorageProvider, AutojoinRoomsMixin, RustSdkCryptoStorageProvider } from 'matrix-bot-sdk';
import { spawn } from 'child_process';
import { createServer } from 'http';
import { createHmac } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import os from 'os';

// --- Config ---

const MATRIX_HOMESERVER_URL = process.env.MATRIX_HOMESERVER_URL || 'http://localhost:6167';
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
if (!MATRIX_ACCESS_TOKEN) {
  console.error('MATRIX_ACCESS_TOKEN is required in .env');
  process.exit(1);
}

const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

const DEFAULT_WORKDIR = process.env.DEFAULT_WORKDIR || process.cwd();
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT || '3600000', 10);
const MAX_MSG_LENGTH = 32768;  // Matrix supports ~65KB, use 32K as practical limit
const DEBUG = process.env.DEBUG === '1';
const SESSIONS_FILE = path.join(os.homedir(), '.claude-matrix-sessions.json');

// Server label for room names: "dev-2" → "D2", fallback to SERVER_LABEL env var
const SERVER_LABEL = process.env.SERVER_LABEL || (() => {
  const hostname = os.hostname();
  const match = hostname.match(/^(\w+)-(\d+)/);
  if (match) return match[1].charAt(0).toUpperCase() + match[2];
  return hostname.slice(0, 4).toUpperCase();
})();
const HMAC_SECRET = process.env.HMAC_SECRET || '';
const VIEWER_BASE_URL = process.env.VIEWER_BASE_URL || '';
const LINK_EXPIRY_MS = parseInt(process.env.LINK_EXPIRY_MS || String(15 * 60 * 1000), 10);

// Plan file patterns — files that get a "view in browser" link
const PLAN_FILE_PATTERNS = [
  /plan/i, /todo/i, /task/i, /readme/i, /\.md$/i, /checklist/i, /notes/i, /summary/i,
];

function generateFileLink(filePath) {
  if (!HMAC_SECRET || !VIEWER_BASE_URL) return null;
  const exp = Math.floor((Date.now() + LINK_EXPIRY_MS) / 1000);
  const payload = Buffer.from(JSON.stringify({ path: filePath, exp })).toString('base64url');
  const sig = createHmac('sha256', HMAC_SECRET).update(payload).digest('base64url');
  return `${VIEWER_BASE_URL}/view?token=${payload}.${sig}`;
}

function generateActionLink(action, roomId) {
  if (!HMAC_SECRET || !VIEWER_BASE_URL) return null;
  const exp = Math.floor((Date.now() + LINK_EXPIRY_MS) / 1000);
  const payload = Buffer.from(JSON.stringify({ action, roomId, exp })).toString('base64url');
  const sig = createHmac('sha256', HMAC_SECRET).update(payload).digest('base64url');
  return `${VIEWER_BASE_URL}/action?token=${payload}.${sig}`;
}

function isPlanFile(filePath) {
  const basename = path.basename(filePath);
  return PLAN_FILE_PATTERNS.some(p => p.test(basename));
}

function debug(...args) {
  if (DEBUG) console.log('[DEBUG]', ...args);
}

// --- Session Persistence ---

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

function persistSession(roomId, sessionId, workdir, originRoomId) {
  const data = loadPersistedSessions();
  data[String(roomId)] = { sessionId, workdir, lastUsed: Date.now(), originRoomId: originRoomId || null };
  savePersistedSessions(data);
}

function getPersistedSession(roomId) {
  const data = loadPersistedSessions();
  return data[String(roomId)] || null;
}

// --- Session Manager ---

const sessions = new Map(); // roomId -> session

function createSession(roomId, workdir, resumeSessionId) {
  const cwd = workdir || DEFAULT_WORKDIR;
  const args = [
    '--print',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--disallowed-tools', 'AskUserQuestion',
    '--append-system-prompt', 'When you need to ask the user a question, use the mcp__ask-matrix-user__ask_matrix_user tool instead of AskUserQuestion. AskUserQuestion is not available in this environment.',
    '--include-partial-messages',
    '--mcp-config', path.join(__dirname, 'mcp-config.json'),
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
    pendingPlanDenialId: null,
    sendHtml: null,
    showWorking: false,
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
      } catch (e) {
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
  const plainText = questions.map((q, i) => formatQuestion(q, i, total)).join('\n\n');
  const html = questions.map((q, i) => formatQuestionHtml(q, i, total)).join('\n\n');

  if (session.sendHtml) {
    session.sendHtml(plainText, html);
  } else if (session.sendCallback) {
    session.sendCallback(plainText);
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
            const cmd = input.command.length > 100
              ? input.command.slice(0, 100) + '…'
              : input.command;
            indicator = `🔧 \`${cmd}\``;
            indicatorHtml = `🔧 <code>${escapeHtml(cmd)}</code>`;
          } else if (toolName === 'Read' && input.file_path) {
            indicator = `📖 ${input.file_path}`;
            indicatorHtml = `📖 <code>${escapeHtml(input.file_path)}</code>`;
          } else if (toolName === 'Write' && input.file_path) {
            indicator = `✏️ Writing ${input.file_path}`;
            indicatorHtml = `✏️ Writing <code>${escapeHtml(input.file_path)}</code>`;
            isKeyEvent = true;
            if (isPlanFile(input.file_path)) {
              const absPath = path.isAbsolute(input.file_path)
                ? input.file_path
                : path.join(session.workdir, input.file_path);
              const link = generateFileLink(absPath);
              if (link) {
                indicator += `\n[🔗 View in browser](${link})`;
                indicatorHtml += `<br/><a href="${link}">🔗 View in browser</a>`;
              }
            }
          } else if (toolName === 'Edit' && input.file_path) {
            indicator = `✏️ Editing ${input.file_path}`;
            indicatorHtml = `✏️ Editing <code>${escapeHtml(input.file_path)}</code>`;
            isKeyEvent = true;
            if (isPlanFile(input.file_path)) {
              const absPath = path.isAbsolute(input.file_path)
                ? input.file_path
                : path.join(session.workdir, input.file_path);
              const link = generateFileLink(absPath);
              if (link) {
                indicator += `\n[🔗 View in browser](${link})`;
                indicatorHtml += `<br/><a href="${link}">🔗 View in browser</a>`;
              }
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

        // Send action links after the result
        if (session.sendHtml) {
          const stopLink = generateActionLink('stop', session.roomId);
          const interruptLink = generateActionLink('interrupt', session.roomId);
          if (stopLink || interruptLink) {
            const links = [];
            const plainLinks = [];
            if (interruptLink) {
              links.push(`<a href="${interruptLink}">⚡ Interrupt</a>`);
              plainLinks.push('⚡ Interrupt');
            }
            if (stopLink) {
              links.push(`<a href="${stopLink}">🛑 Stop Session</a>`);
              plainLinks.push('🛑 Stop Session');
            }
            session.sendHtml(plainLinks.join(' · '), links.join(' · '));
          }
        }
      } else {
        session.responseBuffer = '';
      }
      session.busy = false;
      if (session.typingInterval) {
        clearInterval(session.typingInterval);
        session.typingInterval = null;
        client.setTyping(session.roomId, false, 1000).catch(() => {});
      }

      // Check for ExitPlanMode permission denial — present Build prompt
      const denials = event.permission_denials || [];
      const planDenial = denials.find(d => d.tool_name === 'ExitPlanMode');
      if (planDenial && session.sendCallback) {
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
        if (session.sendCallback) {
          session.sendCallback(`📬 Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''}...`);
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
        if (session.sendHtml) {
          const n = notice('info', '🗜️ Context compacted — conversation history was summarized to free up space.');
          session.sendHtml(n.plain, n.html);
        } else if (session.sendCallback) {
          session.sendCallback('🗜️ Context compacted — conversation history was summarized to free up space.');
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
      const evt = event.event;
      if (evt?.type === 'message_delta' && evt?.context_management?.applied_edits?.length > 0) {
        if (session.sendHtml) {
          const n = notice('info', '🗜️ Context compacted — conversation history was summarized to free up space.');
          session.sendHtml(n.plain, n.html);
        } else if (session.sendCallback) {
          session.sendCallback('🗜️ Context compacted — conversation history was summarized to free up space.');
        }
      }
      break;
    }

    case 'user': {
      const userContent = event.message?.content;
      if (Array.isArray(userContent)) {
        for (const block of userContent) {
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

  const parts = processed.split(/(```[\s\S]*?```|`[^`\n]+`)/g);

  return parts.map((part, i) => {
    if (i % 2 === 1) {
      if (part.startsWith('```')) {
        const inner = part.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
        const lineCount = inner.split('\n').length;
        if (lineCount > 15) {
          return `<details><summary>Code (${lineCount} lines)</summary><pre>${escapeHtml(inner)}</pre></details>`;
        }
        return `<pre>${escapeHtml(inner)}</pre>`;
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

    // Unordered lists: lines starting with - or *
    html = html.replace(/^(?:[-*])\s+(.+)$/gm, '<li>$1</li>');

    // Ordered lists: lines starting with 1. 2. etc
    html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

    // Tables: consecutive lines starting with |
    html = html.replace(/(?:^|\n)((?:\|[^\n]+\|\n?)+)/g, (match, tableBlock) => {
      const rows = tableBlock.trim().split('\n').filter(r => r.trim());
      // Filter out separator rows (|---|---|)
      const dataRows = rows.filter(r => !/^\|[\s\-:|]+\|$/.test(r));
      if (dataRows.length === 0) return match;

      const parseRow = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const headerCells = parseRow(dataRows[0]);
      // It's a table with headers if the second original row is a separator
      const hasSeparator = rows.length > 1 && /^\|[\s\-:|]+\|$/.test(rows[1]);

      let tableHtml = '<table>';
      if (hasSeparator) {
        tableHtml += '<thead><tr>' + headerCells.map(c => `<th>${c}</th>`).join('') + '</tr></thead>';
        tableHtml += '<tbody>' + dataRows.slice(1).map(r => {
          const cells = parseRow(r);
          return '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
        }).join('') + '</tbody>';
      } else {
        tableHtml += '<tbody>' + dataRows.map(r => {
          const cells = parseRow(r);
          return '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
        }).join('') + '</tbody>';
      }
      tableHtml += '</table>';
      return tableHtml;
    });

    // Wrap consecutive <li> in <ul>
    html = html.replace(/(<li>[\s\S]*?<\/li>)(\n<li>[\s\S]*?<\/li>)*/g, (match) => {
      return `<ul>${match}</ul>`;
    });

    html = html.replace(/‹b›‹code›/g, '<b><code>');
    html = html.replace(/‹\/code›‹\/b›/g, '</code></b>');

    // Convert newlines to <br/> (but not before/after block elements)
    html = html.replace(/\n/g, '<br/>');

    // Clean up excessive <br/> around block elements
    html = html.replace(/<br\/>(<\/?(?:hr|li|pre|ol|ul|table|thead|tbody|tr|th|td|blockquote|details|summary)(?:\s[^>]*)?>)/g, '$1');
    html = html.replace(/(<\/?(?:hr|li|pre|ol|ul|table|thead|tbody|tr|th|td|blockquote|details|summary)(?:\s[^>]*)?>)<br\/>/g, '$1');

    return html;
  }).join('');
}

// Improve plain text body for clients that don't render HTML (e.g. Element X)
// Wraps pipe tables in code fences so they render monospaced
function plainTextFormat(text) {
  return text.replace(/((?:^\|.+\|\n?)+)/gm, (match) => {
    return '```\n' + match.trimEnd() + '\n```';
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

// --- Matrix Client ---

const storage = new SimpleFsStorageProvider(path.join(os.homedir(), '.claude-matrix-bot-state.json'));
const cryptoStorage = new RustSdkCryptoStorageProvider(path.join(os.homedir(), '.claude-matrix-bot-crypto'));
const client = new MatrixClient(MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, storage, cryptoStorage);
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
    await client.sendMessage(roomId, content);
  } catch (e) {
    console.error('Failed to send message:', e.message);
  }
}

// --- Room Management ---

async function createSessionRoom(inviteUserId) {
  const roomId = await client.createRoom({
    preset: 'private_chat',
    name: `${SERVER_LABEL}: New session`,
    invite: [inviteUserId],
    initial_state: [
      {
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      },
    ],
  });
  debug(`Created session room ${roomId} for ${inviteUserId}`);
  return roomId;
}

async function updateRoomName(roomId, name) {
  try {
    await client.sendStateEvent(roomId, 'm.room.name', '', { name });
  } catch (e) {
    debug(`Failed to update room name: ${e.message}`);
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

// --- Media Handling ---

async function downloadMatrixFile(mxcUrl) {
  const content = await client.downloadContent(mxcUrl);
  return Buffer.from(content.data);
}

async function buildMediaContentBlocks(event, session) {
  const blocks = [];
  const content = event.content;
  const mxcUrl = content.url;

  if (!mxcUrl) return blocks;

  const buffer = await downloadMatrixFile(mxcUrl);
  const fileName = content.body || 'file';
  const mime = content.info?.mimetype || 'application/octet-stream';

  if (content.msgtype === 'm.image') {
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
      const workdir = explicitWorkdir || DEFAULT_WORKDIR;

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

      const session = createSession(sessionRoomId, workdir);
      session.originRoomId = roomId;
      session.sendCallback = sessionSendReply;
      session.sendHtml = sessionSendHtml;

      // Confirm in origin room with a link to the new room
      const roomLink = `https://matrix.to/#/${sessionRoomId}`;
      await sendReply(`Session started in new room: ${roomLink}`);

      // Welcome message in the session room
      const welcomePlain = `Session started.\nWorkdir: ${workdir}\n\nSend any message to interact with Claude Code.`;
      const welcomeHtml =
        `<b>Session started</b><br/>` +
        `Workdir: <code>${escapeHtml(workdir)}</code><br/><br/>` +
        `<i>Send any message to interact with Claude Code.</i>`;
      await sessionSendHtml(welcomePlain, welcomeHtml);
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
      restarted.originRoomId = existing.originRoomId;
      restarted.firstMessageCaptured = existing.firstMessageCaptured;
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

      const resumeWorkdir = DEFAULT_WORKDIR;
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
      const num = /^\d+$/.test(resumeArg) ? parseInt(resumeArg, 10) : NaN;
      if (!isNaN(num) && num >= 1 && num <= files.length) {
        resumeSessionId = files[num - 1];
      } else {
        const match = files.find(f => f.startsWith(resumeArg));
        if (match) {
          resumeSessionId = match;
        } else {
          await sendReply(`Session not found: ${resumeArg}\nUse !sessions to list available sessions.`);
          return;
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
      const summary = getSessionSummary(resumeSessionId, resumeWorkdir);
      const roomName = summary
        ? `${SERVER_LABEL}: ${summary.slice(0, 50)}${summary.length > 50 ? '…' : ''}`
        : `${SERVER_LABEL}: Resumed ${shortId}`;
      await updateRoomName(sessionRoomId, roomName);

      const sessionSendReply = (reply) => sendToRoom(sessionRoomId, plainTextFormat(reply), markdownToHtml(reply));
      const sessionSendHtml = (plainText, html) => sendToRoom(sessionRoomId, plainText, html);

      const session = createSession(sessionRoomId, resumeWorkdir, resumeSessionId);
      session.originRoomId = roomId;
      session.firstMessageCaptured = true; // don't re-rename on first message
      session.sendCallback = sessionSendReply;
      session.sendHtml = sessionSendHtml;

      // Persist immediately — we already know the session ID, don't wait for Claude's event
      persistSession(sessionRoomId, resumeSessionId, resumeWorkdir, roomId);

      const roomLink = `https://matrix.to/#/${sessionRoomId}`;
      await sendReply(`Resuming session ${shortId}… in new room: ${roomLink}`);
      const resumePlain = `Resuming session ${shortId}…\nWorkdir: ${resumeWorkdir}\n\nSend any message to continue.`;
      const resumeHtml =
        `<b>Resuming session <code>${shortId}</code>…</b><br/>` +
        `Workdir: <code>${escapeHtml(resumeWorkdir)}</code><br/><br/>` +
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

      const resolved = path.resolve(newDir);

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

      const session = createSession(sessionRoomId, resolved);
      session.originRoomId = roomId;
      session.sendCallback = sessionSendReply;
      session.sendHtml = sessionSendHtml;

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
      const htmlRows = items.map((s, i) => {
        const date = new Date(s.modified).toISOString().replace('T', ' ').slice(0, 16);
        const shortId = s.sessionId.slice(0, 8);
        const active = s.sessionId === activeId ? ' ⚡' : '';
        const desc = s.summary
          ? `<br/><span style="color:gray">${s.summary.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>`
          : '';
        return `<li><b>${shortId}</b> <code>${date}</code>${active}${desc}</li>`;
      }).join('\n');

      const plainText = `Sessions for ${workdir}:\n\n${plainList}\n\nUse !resume <number> or !resume <id> to resume.`;
      const html = `<b>Sessions for ${workdir}:</b><ol>\n${htmlRows}\n</ol><i>Use <code>!resume &lt;number&gt;</code> or <code>!resume &lt;id&gt;</code> to resume.</i>`;

      await sendHtml(plainText, html);
      break;
    }

    case '!help': {
      const plainHelp =
        `Available commands:\n\n` +
        `!start — Start a new session (creates a new room)\n` +
        `!start <workdir> — Start in a specific directory\n` +
        `!stop — Stop the current session\n` +
        `!restart — Stop and immediately resume the session\n` +
        `!resume <n> — Resume session #n from !sessions list\n` +
        `!resume <id> — Resume session by ID prefix\n` +
        `!sessions — List all past sessions\n` +
        `!workdir <path> — Start session in a different directory\n` +
        `!status — Show current session info\n` +
        `!working — Toggle tool call visibility\n` +
        `!mcp — Show MCP server status\n` +
        `!model — Show current model\n` +
        `!cost — Show session cost\n` +
        `!usage — Show token usage\n` +
        `!tools — List available tools\n` +
        `!help — Show this help message\n\n` +
        `Each !start, !resume, and !workdir creates a new encrypted room for the session.\n` +
        `Room names show the server (${SERVER_LABEL}) and first message summary.\n\n` +
        `While Claude is working:\n` +
        `  Messages are queued automatically\n` +
        `  Send "interrupt" to force interrupt\n\n` +
        `Claude Code slash commands (e.g. /commit, /review-pr) are passed through directly.\n` +
        `Send any other text to chat with Claude Code.\n` +
        `You can also send photos and documents (PDFs, images, text files).`;

      const cmdGroup = (title, cmds) => {
        const items = cmds.map(([c, d]) => `<li><code>${c}</code> — ${d}</li>`).join('');
        return `<b>${title}</b><ul>${items}</ul>`;
      };

      const htmlHelp =
        cmdGroup('Sessions', [
          ['!start', 'Start a new session (creates a new room)'],
          ['!start &lt;workdir&gt;', 'Start in a specific directory'],
          ['!stop', 'Stop the current session'],
          ['!restart', 'Stop and immediately resume the session'],
          ['!resume &lt;n&gt;', 'Resume session #n from !sessions list'],
          ['!resume &lt;id&gt;', 'Resume session by ID prefix'],
          ['!sessions', 'List all past sessions'],
          ['!workdir &lt;path&gt;', 'Start session in a different directory'],
        ]) +
        cmdGroup('Info', [
          ['!status', 'Show current session info'],
          ['!working', 'Toggle tool call visibility'],
          ['!mcp', 'Show MCP server status'],
          ['!model', 'Show current model'],
          ['!cost', 'Show session cost'],
          ['!usage', 'Show token usage'],
          ['!tools', 'List available tools'],
          ['!help', 'Show this help message'],
        ]) +
        `<b>Tips</b><ul>` +
        `<li>Each <code>!start</code>, <code>!resume</code>, and <code>!workdir</code> creates a new encrypted room</li>` +
        `<li>Room names show the server (<code>${SERVER_LABEL}</code>) and first message summary</li>` +
        `<li>Messages are queued automatically while Claude is working</li>` +
        `<li>Send <code>interrupt</code> to force interrupt</li>` +
        `<li>Slash commands (e.g. <code>/commit</code>) are passed through directly</li>` +
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

  const sender = event.sender;
  if (!isAllowed(sender)) return;

  const msgtype = event.content.msgtype;
  let text = '';
  let hasMedia = false;

  if (msgtype === 'm.text' || msgtype === 'm.notice') {
    text = (event.content.body || '').trim();
  } else if (msgtype === 'm.image' || msgtype === 'm.file') {
    hasMedia = true;
    text = (event.content.body || '').trim();
  }

  if (!text && !hasMedia) return;

  console.log(
    `Message from ${sender} in ${roomId}: ${text.slice(0, 50)}${hasMedia ? ' [media]' : ''}`
  );

  const sendReply = (reply) => sendToRoom(roomId, plainTextFormat(reply), markdownToHtml(reply));
  const sendHtmlFn = (plainText, html) => sendToRoom(roomId, plainText, html);

  // Bridge commands use ! prefix
  if (text.startsWith('!')) {
    const bridgeCommands = new Set([
      '!start', '!stop', '!restart', '!resume', '!workdir', '!status',
      '!show', '!show_working', '!working', '!sessions', '!help',
      '!mcp', '!model', '!cost', '!usage', '!tools',
    ]);
    const cmd = text.split(/\s+/)[0].toLowerCase();
    if (bridgeCommands.has(cmd)) {
      await handleCommand(roomId, text, sendReply, sendHtmlFn, sender);
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
      newSession.sendCallback = sendReply;
      newSession.sendHtml = sendHtmlFn;
      session = newSession;

      const shortId = prev.sessionId.slice(0, 8);
      const arNotice = notice('info', `Auto-resuming session ${shortId}…`, `Auto-resuming session <code>${shortId}</code>…`);
      await sendHtmlFn(arNotice.plain, arNotice.html);
    } else {
      await sendReply('No active session. Send !start to begin.');
      return;
    }
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
  if (session.pendingPlan && text.toLowerCase().trim() === 'build') {
    sendTextToSession(session, 'Go ahead and execute the plan now. Do not re-enter plan mode — just make the changes directly.');
    session.pendingPlan = null;
    const buildNotice = notice('success', '▶️ Building...', '▶️ <b>Building…</b>');
    await sendHtmlFn(buildNotice.plain, buildNotice.html);
    return;
  }

  // Queue/interrupt logic when Claude is busy
  if (session.busy) {
    const lowerText = text.toLowerCase().trim();
    if (lowerText === 'interrupt' || lowerText === '!interrupt') {
      const queued = session.queuedMessages || [];
      session.queuedMessages = null;
      await sendReply(`⚡ Interrupting Claude...${queued.length > 0 ? ` (sending ${queued.length} queued message${queued.length > 1 ? 's' : ''})` : ''}`);
      if (queued.length > 0) {
        flushQueue(session, queued);
      }
      return;
    }
    // Queue the message
    if (!session.queuedMessages) session.queuedMessages = [];

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
    const interruptLink = generateActionLink('interrupt', roomId);
    const plainQueue = `📨 Queued (${count}): ${preview}\nSend "interrupt" to force send now.`;
    if (interruptLink) {
      const htmlQueue = `📨 Queued (${count}): ${escapeHtml(preview)}<br/><a href="${interruptLink}">⚡ Interrupt</a>`;
      await sendHtmlFn(plainQueue, htmlQueue);
    } else {
      await sendReply(plainQueue);
    }
    return;
  }

  session.queuedMessages = null;

  if (hasMedia) {
    try {
      const blocks = await buildMediaContentBlocks(event, session);
      if (blocks.length === 0) {
        await sendReply('Could not process the file.');
        return;
      }
      if (!sendToSession(session, blocks)) {
        await sendReply('Session is not available. Send !start to begin a new one.');
      } else if (!session.firstMessageCaptured) {
        session.firstMessageCaptured = true;
        const fileName = event.content.body || 'file';
        const label = `${SERVER_LABEL}: ${fileName.slice(0, 50)}`;
        updateRoomName(session.roomId, label);
      }
    } catch (err) {
      console.error('Media processing error:', err);
      await sendReply(`Failed to process file: ${err.message}`);
    }
  } else {
    if (!sendTextToSession(session, text)) {
      await sendReply('Session is not available. Send !start to begin a new one.');
    } else if (!session.firstMessageCaptured) {
      session.firstMessageCaptured = true;
      const summary = text.length > 50 ? text.slice(0, 50) + '…' : text;
      updateRoomName(session.roomId, `${SERVER_LABEL}: ${summary}`);
    }
  }
  } catch (err) {
    console.error('[ERROR] room.message handler:', err);
  }
});

// --- MCP Question Store ---

const pendingMcpQuestions = new Map();
let mcpQuestionCounter = 0;

// --- Local HTTP API ---

const API_PORT = parseInt(process.env.API_PORT || '9802', 10);

const apiServer = createServer((req, res) => {
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

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = JSON.parse(body);

      // POST /ask — MCP server posts a question
      if (url.pathname === '/ask') {
        const { question, header, options } = data;
        if (!question) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'question is required' }));
          return;
        }

        const questionId = String(++mcpQuestionCounter);

        pendingMcpQuestions.set(questionId, {
          question, header, options,
          answered: false, answer: null,
        });

        // Find the active session and show the question
        let activeSession = null;
        for (const [, s] of sessions) {
          if (s.alive) { activeSession = s; break; }
        }

        if (activeSession) {
          const parsed = {
            questions: [{
              question,
              header: header || null,
              options: options || [],
              multiSelect: false,
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
    } catch (e) {
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
  botUserId = await client.getUserId();
  console.log(`Bot logged in as ${botUserId}`);
  console.log(`Homeserver: ${MATRIX_HOMESERVER_URL}`);
  console.log(`Allowed users: ${ALLOWED_USER_IDS.length ? ALLOWED_USER_IDS.join(', ') : 'any'}`);
  console.log(`Default workdir: ${DEFAULT_WORKDIR}`);
  console.log(`Session timeout: ${SESSION_TIMEOUT}ms`);
  console.log(`Debug mode: ${DEBUG ? 'ON' : 'OFF'}`);

  await client.start();
  console.log('Matrix client started, listening for messages...');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  for (const [, session] of sessions) {
    if (session.alive) session.proc.kill();
  }
  client.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  for (const [, session] of sessions) {
    if (session.alive) session.proc.kill();
  }
  client.stop();
  process.exit(0);
});
