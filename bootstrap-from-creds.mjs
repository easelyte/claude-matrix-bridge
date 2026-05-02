#!/usr/bin/env node
/**
 * One-shot bootstrap that runs on the bridge box's first start.
 * Inputs (env): MATRIX_HOMESERVER_URL, MATRIX_BOT_USER_ID,
 *               MATRIX_BOT_PASSWORD, MATRIX_BOT_RECOVERY_KEY
 * Output: prints `access_token=<value>` to stdout (last line).
 *
 * Steps:
 *   1. Login with password → access token + device_id (fresh device on this box)
 *   2. initRustCrypto + sync (does NOT persist; one-shot)
 *   3. bootstrapSecretStorage with the existing recovery key (no new key)
 *   4. bootstrapCrossSigning — signs THIS device with bot's self-signing key
 *   5. Print access_token=...
 */

import * as sdk from 'matrix-js-sdk';
import { logger } from 'matrix-js-sdk/lib/logger.js';
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/recovery-key.js';

logger.setLevel('silent');

const HOMESERVER = process.env.MATRIX_HOMESERVER_URL || 'http://localhost:6167';
const BOT_USER_ID = process.env.MATRIX_BOT_USER_ID;
const BOT_PASSWORD = process.env.MATRIX_BOT_PASSWORD;
const BOT_RECOVERY_KEY = process.env.MATRIX_BOT_RECOVERY_KEY;

if (!BOT_USER_ID || !BOT_PASSWORD || !BOT_RECOVERY_KEY) {
  console.error('bootstrap-from-creds: missing required env (MATRIX_BOT_USER_ID, MATRIX_BOT_PASSWORD, MATRIX_BOT_RECOVERY_KEY)');
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
    }),
  });
  const loginData = await loginResp.json();
  if (!loginData.access_token) {
    console.error('bootstrap-from-creds: login failed', JSON.stringify(loginData));
    process.exit(3);
  }

  let decodedKey;
  const client = sdk.createClient({
    baseUrl: HOMESERVER,
    accessToken: loginData.access_token,
    userId: loginData.user_id,
    deviceId: loginData.device_id,
    cryptoCallbacks: {
      getSecretStorageKey: async ({ keys }) => {
        const keyId = Object.keys(keys)[0];
        if (!decodedKey) decodedKey = decodeRecoveryKey(BOT_RECOVERY_KEY);
        return [keyId, decodedKey];
      },
    },
  });

  await client.initRustCrypto({ useIndexedDB: false });
  const cryptoApi = client.getCrypto();

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Sync timeout')), 30000);
    client.once(sdk.ClientEvent.Sync, (state) => {
      clearTimeout(timeout);
      if (state === 'PREPARED' || state === 'SYNCING') resolve();
      else reject(new Error('Sync: ' + state));
    });
    client.startClient({ initialSyncLimit: 0 });
  });
  await new Promise(r => setTimeout(r, 1500));

  // Restores the cached cross-signing private keys from server-side SSSS
  // (no new key created — getSecretStorageKey provides BOT_RECOVERY_KEY).
  await cryptoApi.bootstrapSecretStorage({});
  await cryptoApi.bootstrapCrossSigning({
    authUploadDeviceSigningKeys: async (makeRequest) => makeRequest({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: loginData.user_id },
      password: BOT_PASSWORD,
    }),
  });

  // Stop the throwaway client so the bridge can take over with this token.
  client.stopClient();
  process.stdout.write(`access_token=${loginData.access_token}\n`);
  process.exit(0);
}

main().catch(e => { console.error('Failed:', e.stack || e.message); process.exit(1); });
