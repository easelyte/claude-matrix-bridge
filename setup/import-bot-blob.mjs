#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, chmodSync, copyFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SCRIPT_DIR, '..');
const DEFAULT_ENV_PATH = join(REPO_DIR, '.env');
const DEFAULT_ENV_EXAMPLE_PATH = join(REPO_DIR, '.env.example');

const VERSION = 'db1';
const REQUIRED_KEYS = [
  'homeserver_url',
  'server_domain',
  'bot_user_id',
  'bot_password',
  'bot_recovery_key',
  'bridge_room_id',
];

function usage() {
  console.error(`Usage: node setup/import-bot-blob.mjs [--env .env] <db1:blob>
       printf '%s' "$BLOB" | node setup/import-bot-blob.mjs [--env .env] --stdin`);
}

function parseArgs(argv) {
  let envPath = DEFAULT_ENV_PATH;
  let fromStdin = false;
  let blob = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--env') {
      envPath = resolve(argv[++i] || '');
    } else if (arg === '--stdin') {
      fromStdin = true;
    } else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else if (!blob) {
      blob = arg;
    } else {
      console.error(`Unexpected argument: ${arg}`);
      usage();
      process.exit(64);
    }
  }

  if (fromStdin) {
    blob = readFileSync(0, 'utf8').trim();
  }

  if (!blob) {
    usage();
    process.exit(64);
  }

  return { envPath, blob };
}

function decodeBlob(input) {
  const [version, encoded] = String(input).split(':', 2);
  if (version !== VERSION || !encoded) {
    throw new Error(`input must start with ${VERSION}:`);
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (e) {
    throw new Error(`blob body is not valid base64 JSON: ${e.message}`, { cause: e });
  }

  const missing = REQUIRED_KEYS.filter((key) => !payload[key]);
  if (missing.length) {
    throw new Error(`blob missing required keys: ${missing.join(', ')}`);
  }

  const userIdMatch = String(payload.bot_user_id).match(/^@[^:]+:(.+)$/);
  if (!userIdMatch) {
    throw new Error(`bot_user_id is not a valid Matrix user ID`);
  }
  if (userIdMatch[1] !== payload.server_domain) {
    throw new Error(`bot_user_id domain does not match server_domain`);
  }

  return payload;
}

function ensureEnvFile(envPath) {
  if (existsSync(envPath)) return;
  copyFileSync(DEFAULT_ENV_EXAMPLE_PATH, envPath);
  chmodSync(envPath, 0o600);
}

function updateEnv(envPath, values) {
  ensureEnvFile(envPath);

  const lines = readFileSync(envPath, 'utf8').split(/\n/);
  const seen = new Set();
  const updated = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;

    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(values, key)) return line;

    seen.add(key);
    return `${key}=${values[key]}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) updated.push(`${key}=${value}`);
  }

  writeFileSync(envPath, updated.join('\n').replace(/\n*$/, '\n'));
  chmodSync(envPath, 0o600);
}

function main() {
  const { envPath, blob } = parseArgs(process.argv.slice(2));
  const payload = decodeBlob(blob);

  updateEnv(envPath, {
    MATRIX_HOMESERVER_URL: payload.homeserver_url,
    MATRIX_BOT_USER_ID: payload.bot_user_id,
    MATRIX_BOT_PASSWORD: payload.bot_password,
    MATRIX_BOT_RECOVERY_KEY: payload.bot_recovery_key,
    BRIDGE_ROOM_ID: payload.bridge_room_id,
  });

  console.log(`Imported bot credentials for ${payload.bot_user_id}`);
  console.log(`Updated ${envPath}`);
}

try {
  main();
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}
