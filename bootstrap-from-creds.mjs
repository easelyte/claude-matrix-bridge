#!/usr/bin/env node
/**
 * One-shot bootstrap that runs on the bridge box's first start.
 * Inputs (env): MATRIX_HOMESERVER_URL, MATRIX_BOT_USER_ID,
 *               MATRIX_BOT_PASSWORD, MATRIX_BOT_RECOVERY_KEY
 * Output: prints `access_token=<value>` to stdout (last line).
 *
 * Steps:
 *   1. Login with password → access token + device_id (fresh device on this box)
 *   2. Print access_token=...
 *
 * Important: do not initialize crypto here. The long-running bridge uses
 * matrix-bot-sdk and must be the first crypto implementation to upload device
 * keys for this access-token device; otherwise the server can advertise keys
 * that do not match the bridge's local crypto store.
 */

const HOMESERVER = process.env.MATRIX_HOMESERVER_URL || 'http://localhost:6167';
const BOT_USER_ID = process.env.MATRIX_BOT_USER_ID;
const BOT_PASSWORD = process.env.MATRIX_BOT_PASSWORD;

if (!BOT_USER_ID || !BOT_PASSWORD) {
  console.error('bootstrap-from-creds: missing required env (MATRIX_BOT_USER_ID, MATRIX_BOT_PASSWORD)');
  process.exit(2);
}

const localpart = BOT_USER_ID.replace(/^@/, '').split(':')[0];

async function main() {
  const loginResp = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: localpart },
      password: BOT_PASSWORD,
      initial_device_display_name: 'Matron Matrix Bridge',
    }),
  });
  const loginData = await loginResp.json();
  if (!loginData.access_token) {
    console.error('bootstrap-from-creds: login failed', JSON.stringify(loginData));
    process.exit(3);
  }

  process.stdout.write(`access_token=${loginData.access_token}\n`);
  process.exit(0);
}

main().catch(e => { console.error('Failed:', e.stack || e.message); process.exit(1); });
