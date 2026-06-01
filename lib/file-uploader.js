import fs from 'fs';
import path from 'path';
import { generateSignedUrl } from './viewer-tokens.js';

const SENSITIVE_BASENAME_PATTERNS = [
  /\.env(\..*)?$/i,
  /secrets?\.(json|ya?ml|toml|txt)$/i,
  /^credentials$/i,
  /credentials?\.(json|ya?ml|toml|txt)$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /id_rsa|id_ed25519|id_ecdsa/i,
  /\.npmrc$/i,
  /\.netrc$/i,
  /token(s)?\.(json|txt)$/i,
  /service[-_]?account.*\.json$/i,
  /\.htpasswd$/i,
  /^config\.json$/i,
];

const SENSITIVE_PATH_PATTERNS = [
  /\/\.aws\//i,
  /\/\.docker\//i,
  /\/\.kube\//i,
  /\/\.ssh\//i,
  /\/\.gnupg\//i,
];

export function isSensitivePath(filePath) {
  const basename = path.basename(filePath);
  if (SENSITIVE_BASENAME_PATTERNS.some(re => re.test(basename))) return true;
  if (SENSITIVE_PATH_PATTERNS.some(re => re.test(filePath))) return true;
  return false;
}

export async function resolveInWorkdir(filePath, workdir) {
  const normalizedWorkdir = workdir.replace(/\/+$/, '');
  let resolvedPath;
  try {
    resolvedPath = await fs.promises.realpath(filePath);
  } catch {
    resolvedPath = filePath;
  }
  let resolvedWorkdir;
  try {
    resolvedWorkdir = await fs.promises.realpath(normalizedWorkdir);
  } catch {
    resolvedWorkdir = normalizedWorkdir;
  }
  if (resolvedPath === resolvedWorkdir || resolvedPath.startsWith(resolvedWorkdir + '/')) {
    return resolvedPath;
  }
  return null;
}

export function logFileDecision({ toolUseId, filePath, decision, size = null, error = null }) {
  console.log(JSON.stringify({
    tag: 'file-link',
    tool_use_id: toolUseId || null,
    file: filePath ? path.basename(filePath) : null,
    decision,
    size,
    error,
  }));
}

const DEFAULT_MAX_BYTES = 5242880; // 5MB

export async function sendFileViewerLink(sendHtml, filePath, opts = {}) {
  const { maxBytes = DEFAULT_MAX_BYTES, toolUseId, workdir, viewerBaseUrl, hmacSecret } = opts;

  if (!viewerBaseUrl || !hmacSecret) {
    logFileDecision({ toolUseId, filePath, decision: 'skipped-viewer-not-configured' });
    return null;
  }

  if (workdir) {
    const resolvedPath = await resolveInWorkdir(filePath, workdir);
    if (!resolvedPath) {
      logFileDecision({ toolUseId, filePath, decision: 'denied-out-of-scope' });
      return null;
    }
    filePath = resolvedPath;
  }

  if (isSensitivePath(filePath)) {
    logFileDecision({ toolUseId, filePath, decision: 'denied-sensitive' });
    return null;
  }

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (err) {
    logFileDecision({ toolUseId, filePath, decision: 'skipped-missing', error: err.message });
    return null;
  }

  if (!stat.isFile()) {
    logFileDecision({ toolUseId, filePath, decision: 'skipped-not-regular' });
    return null;
  }

  if (stat.size > maxBytes) {
    logFileDecision({ toolUseId, filePath, decision: 'skipped-size', size: stat.size });
    return null;
  }

  const url = generateSignedUrl(viewerBaseUrl, filePath, hmacSecret, undefined, {
    path: filePath,
    workdir: workdir || null,
    maxBytes,
  });
  const filename = path.basename(filePath);
  const escaped = filename.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  if (sendHtml) {
    try {
      await Promise.resolve(sendHtml(`📎 ${filename}`, `📎 <a href="${url}">${escaped}</a>`));
    } catch (err) {
      logFileDecision({ toolUseId, filePath, decision: 'send-failed', size: stat.size, error: err.message });
      return null;
    }
  }

  logFileDecision({ toolUseId, filePath, decision: 'linked', size: stat.size });
  return url;
}
