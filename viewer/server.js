import express from 'express';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const PORT = process.env.PORT || 9801;
const SECRET = process.env.HMAC_SECRET;
const TOKEN_EXPIRY_SECONDS = parseInt(process.env.TOKEN_EXPIRY || '3600', 10);

if (!SECRET) {
  console.error('HMAC_SECRET env var is required');
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Generate a signed token for a file path
// Token format: base64url(json({path, exp})) + '.' + hmac
export function generateSignedUrl(baseUrl, filePath, secret = SECRET, expiry = TOKEN_EXPIRY_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + expiry;
  const payload = Buffer.from(JSON.stringify({ path: filePath, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${baseUrl}/view?token=${payload}.${sig}`;
}

function verifyToken(token) {
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
      return res.type('html').send(`<!DOCTYPE html><html><body><h2>Action failed</h2><p>${err}</p></body></html>`);
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
      return res.status(resp.status).type('html').send(
        `<!DOCTYPE html><html><body style="background:#0d1117;color:#e6edf3;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;"><div><h2>Submission failed</h2><p>${err}</p></div></body></html>`
      );
    }

    res.type('html').send(renderSecretSuccess());
  } catch (err) {
    console.error('Secret submit proxy error:', err);
    res.status(500).send('Failed to reach bridge API');
  }
});

app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Code file viewer listening on 127.0.0.1:${PORT}`);
});
