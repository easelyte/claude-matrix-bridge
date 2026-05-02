import express from 'express';
import crypto from 'crypto';
import fs from 'fs/promises';
import { watch as fsWatch, existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';

const PORT = process.env.MATRIX_VIEWER_PORT || 9803;
const SECRET = process.env.HMAC_SECRET;
const TOKEN_EXPIRY_SECONDS = parseInt(process.env.TOKEN_EXPIRY || '3600', 10);

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Generate a signed token for a file path or arbitrary payload
// Token format: base64url(json({path, exp})) + '.' + hmac
// When `extra` is provided, it replaces the default {path} payload (exp is always added).
export function generateSignedUrl(baseUrl, filePath, secret = SECRET, expiry = TOKEN_EXPIRY_SECONDS, extra = null) {
  const exp = Math.floor(Date.now() / 1000) + expiry;
  const payloadObj = extra ? { ...extra, exp } : { path: filePath, exp };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${baseUrl}/view?token=${payload}.${sig}`;
}

export function verifyToken(token) {
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx === -1) return null;

  const payload = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);

  const expectedSig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

// Syntax highlighting via highlight.js CDN
function renderHtml(filename, content) {
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const ext = path.extname(filename).slice(1);
  const langClass = ext ? `language-${ext}` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${filename}</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
  <style>
    body { margin: 0; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    .header { padding: 12px 20px; background: #161b22; border-bottom: 1px solid #30363d; font-size: 14px; }
    .filename { font-weight: 600; }
    pre { margin: 0; padding: 16px 20px; overflow-x: auto; }
    code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="header"><span class="filename">${filename}</span></div>
  <pre><code class="${langClass}">${escaped}</code></pre>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script>hljs.highlightAll();</script>
</body>
</html>`;
}

function renderSecretForm(label, token) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Enter Secret</title>
  <style>
    body { margin: 0; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 32px; max-width: 480px; width: 100%; }
    h2 { margin: 0 0 8px; font-size: 18px; }
    .label { color: #8b949e; margin-bottom: 20px; font-size: 14px; }
    input[type="password"] { width: 100%; padding: 10px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 14px; box-sizing: border-box; }
    input[type="password"]:focus { outline: none; border-color: #58a6ff; }
    button { margin-top: 16px; padding: 10px 24px; background: #238636; border: none; border-radius: 6px; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; width: 100%; }
    button:hover { background: #2ea043; }
    .note { margin-top: 12px; font-size: 12px; color: #8b949e; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🔐 Enter Secret</h2>
    <div class="label">${label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
    <form method="POST" action="/secret">
      <input type="hidden" name="token" value="${token}">
      <input type="password" name="value" placeholder="Paste secret here..." autofocus required>
      <button type="submit">Submit</button>
    </form>
    <div class="note">This value will be written to a secure file and auto-deleted after 1 hour. It will not appear in chat.</div>
  </div>
</body>
</html>`;
}

function renderSecretSuccess() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Secret Submitted</title>
  <style>
    body { margin: 0; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { text-align: center; padding: 40px; }
    h2 { color: #3fb950; }
  </style>
</head>
<body>
  <div class="card">
    <h2>✅ Secret submitted</h2>
    <p>The secret has been securely saved. You can close this tab.</p>
  </div>
</body>
</html>`;
}

function renderSensitiveData(label, content) {
  const escaped = content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const labelEscaped = label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${labelEscaped}</title>
  <style>
    body { margin: 0; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 20px; }
    .header { padding: 20px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 20px; }
    .label { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    .warning { color: #f85149; font-size: 13px; display: flex; align-items: center; gap: 8px; }
    .content { padding: 20px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; position: relative; }
    .content pre { margin: 0; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; }
    .copy-btn { position: absolute; top: 12px; right: 12px; padding: 6px 12px; background: #238636; border: none; border-radius: 6px; color: #fff; font-size: 12px; cursor: pointer; }
    .copy-btn:hover { background: #2ea043; }
    .copy-btn.copied { background: #1f6feb; }
  </style>
</head>
<body>
  <div class="header">
    <div class="label">🔐 ${labelEscaped}</div>
    <div class="warning">⚠️ This is a one-time link. Once you close this page, the data will be permanently deleted.</div>
  </div>
  <div class="content">
    <button class="copy-btn" onclick="copyToClipboard()">Copy</button>
    <pre id="content">${escaped}</pre>
  </div>
  <script>
    function copyToClipboard() {
      const content = document.getElementById('content').textContent;
      navigator.clipboard.writeText(content).then(() => {
        const btn = document.querySelector('.copy-btn');
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2000);
      });
    }
  </script>
</body>
</html>`;
}

app.get('/view', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');

  try {
    // Resolve and prevent path traversal
    const filePath = path.resolve(data.path);
    const content = await fs.readFile(filePath, 'utf-8');
    const filename = path.basename(filePath);

    res.type('html').send(renderHtml(filename, content));
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).send('File not found');
    console.error('Error reading file:', err);
    res.status(500).send('Internal error');
  }
});

const BRIDGE_API_PORT = process.env.MATRIX_BRIDGE_API_PORT || 9802;

app.get('/action', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');

  const { action, roomId, index } = data;
  if (!action || !roomId) return res.status(400).send('Invalid action token');

  try {
    let endpoint, body, label;
    if (action === 'interrupt') {
      endpoint = '/interrupt';
      body = { roomId };
      label = '⚡ Sending queued messages';
    } else if (action === 'cancel') {
      endpoint = '/cancel-queued';
      body = { roomId, index };
      label = '✕ Cancelled';
    } else {
      return res.status(400).send('Unknown action');
    }

    const resp = await fetch(`http://127.0.0.1:${BRIDGE_API_PORT}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.text();
      const safeErr = err.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      return res.type('html').send(`<!DOCTYPE html><html><body><h2>Action failed</h2><p>${safeErr}</p></body></html>`);
    }

    res.type('html').send(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Action performed</title>
<style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,sans-serif;}
.card{text-align:center;padding:40px;}</style></head>
<body><div class="card"><h2>${label}</h2><p>Action performed. You can close this tab.</p></div></body>
</html>`);
  } catch (err) {
    console.error('Action proxy error:', err);
    res.status(500).send('Failed to reach bridge API');
  }
});

app.get('/secret', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');
  if (!data.secretId || !data.label) return res.status(400).send('Invalid secret token');

  res.type('html').send(renderSecretForm(data.label, token));
});

app.post('/secret', async (req, res) => {
  const { token, value } = req.body;
  if (!token || !value) return res.status(400).send('Missing token or value');

  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');
  if (!data.secretId) return res.status(400).send('Invalid secret token');

  try {
    const resp = await fetch(`http://127.0.0.1:${BRIDGE_API_PORT}/secret/${data.secretId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      const safeErr = err.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      return res.status(resp.status).type('html').send(
        `<!DOCTYPE html><html><body style="background:#0d1117;color:#e6edf3;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;"><div><h2>Submission failed</h2><p>${safeErr}</p></div></body></html>`
      );
    }

    res.type('html').send(renderSecretSuccess());
  } catch (err) {
    console.error('Secret submit proxy error:', err);
    res.status(500).send('Failed to reach bridge API');
  }
});

app.get('/sensitive', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');
  if (!data.sensitiveId || !data.label) return res.status(400).send('Invalid sensitive data token');

  try {
    const resp = await fetch(`http://127.0.0.1:${BRIDGE_API_PORT}/sensitive/${data.sensitiveId}`);

    if (!resp.ok) {
      const err = await resp.json();
      const safeErr = (err.error || 'Unknown error').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return res.status(resp.status).type('html').send(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title><style>body{margin:0;background:#0d1117;color:#e6edf3;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}.card{text-align:center;padding:40px;}h2{color:#f85149;}</style></head><body><div class="card"><h2>⚠️ Error</h2><p>${safeErr}</p></div></body></html>`
      );
    }

    const { label, content } = await resp.json();
    res.type('html').send(renderSensitiveData(label, content));
  } catch (err) {
    console.error('Sensitive data fetch error:', err);
    res.status(500).send('Failed to reach bridge API');
  }
});

function renderLiveHtml(token) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, sans-serif; height: 100vh; display: flex; flex-direction: column; }
  pre { margin: 0; padding: 12px; flex: 1; overflow-y: auto; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; line-height: 1.4; white-space: pre-wrap; word-break: break-all; }
  .status { padding: 4px 12px; background: #161b22; border-bottom: 1px solid #30363d; font-size: 11px; color: #8b949e; }
</style>
</head>
<body>
<div class="status" id="status">running…</div>
<pre id="output"></pre>
<script>
(() => {
  const out = document.getElementById('output');
  const status = document.getElementById('status');
  let userScrolled = false;
  out.addEventListener('scroll', () => {
    userScrolled = (out.scrollTop + out.clientHeight) < (out.scrollHeight - 20);
  });
  const wsUrl = location.origin.replace(/^http/, 'ws') + '/live/ws?token=${token}';
  const ws = new WebSocket(wsUrl);
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'data') {
      out.textContent += msg.chunk;
      if (!userScrolled) out.scrollTop = out.scrollHeight;
    } else if (msg.type === 'complete') {
      const code = msg.exitCode;
      const denied = msg.denied;
      const trunc = msg.truncated;
      status.textContent = denied ? '✗ not executed' :
        (code === 0 ? '✓ exit 0' : '✗ exit ' + code) +
        (trunc ? ' · truncated' : '');
    }
  };
  ws.onerror = () => { status.textContent = '⚠ disconnected'; };
})();
</script>
</body>
</html>`;
}

app.get('/live', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');
  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');
  if (!data.liveCmdId) return res.status(400).send('Invalid live token');
  res.type('html').send(renderLiveHtml(token));
});

// Plugin bundle directory — built by matron-web's packages/matron-live-output
// (`pnpm --filter @matron/live-output build`, output `dist/live-output.mjs`).
// Override at deploy time via MATRON_PLUGIN_DIR. Served unauthenticated: the
// bundle is the script the browser dynamic-imports for matron-web's plugin
// loader (see matron-web src/vector/init.tsx :: loadPlugins), so it has to be
// publicly fetchable. Adding HMAC here would just break loading; the contents
// are not secret.
const PLUGIN_DIR = process.env.MATRON_PLUGIN_DIR || path.join(process.cwd(), 'plugins');

app.use('/plugin', express.static(PLUGIN_DIR, {
  fallthrough: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mjs') || filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    }
  },
}));

app.get('/health', (req, res) => res.send('ok'));

export { app };
export function startServer(port = PORT) {
  if (!SECRET) {
    console.error('HMAC_SECRET env var is required');
    process.exit(1);
  }
  const httpServer = app.listen(port, '127.0.0.1', () => {
    const addr = httpServer.address();
    const actualPort = addr && typeof addr === 'object' ? addr.port : port;
    console.log(`Code file viewer listening on 127.0.0.1:${actualPort}`);
  });
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/live/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleLiveWs(ws, url));
  });
  return httpServer;
}

function handleLiveWs(ws, url) {
  const token = url.searchParams.get('token');
  const data = token ? verifyToken(token) : null;
  if (!data || !data.liveCmdId || !data.logPath) {
    ws.close(1008, 'invalid token');
    return;
  }
  const { logPath, doneSentinelPath } = data;

  let offset = 0;
  let watcher = null;
  let doneWatcher = null;
  let closed = false;

  function send(msg) {
    if (closed) return;
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  function pump() {
    if (closed || !existsSync(logPath)) return;
    let st;
    try { st = statSync(logPath); } catch { return; }
    if (st.size <= offset) return;
    let data;
    try {
      const fd = openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(st.size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        data = buf;
      } finally {
        closeSync(fd);
      }
    } catch {
      return;
    }
    offset = st.size;
    send({ type: 'data', chunk: data.toString('utf-8') });
  }

  function checkDone() {
    if (!existsSync(doneSentinelPath)) return;
    pump(); // final flush — synchronous, so any pending bytes are sent before complete
    let payload;
    try { payload = JSON.parse(readFileSync(doneSentinelPath, 'utf-8')); }
    catch { payload = { exitCode: null, denied: false, truncated: false }; }
    send({ type: 'complete', ...payload });
    closeAll();
  }

  function closeAll() {
    if (closed) return;
    closed = true;
    try { watcher?.close(); } catch {}
    try { doneWatcher?.close(); } catch {}
    try { ws.close(1000, 'done'); } catch {}
  }

  pump();
  if (existsSync(logPath)) {
    watcher = fsWatch(logPath, { persistent: false }, () => pump());
  }
  const parentDir = path.dirname(logPath);
  const doneBasename = path.basename(doneSentinelPath);
  doneWatcher = fsWatch(parentDir, { persistent: false }, (event, filename) => {
    if (filename === doneBasename) checkDone();
  });

  ws.on('close', closeAll);
  ws.on('error', closeAll);
  checkDone();
}
