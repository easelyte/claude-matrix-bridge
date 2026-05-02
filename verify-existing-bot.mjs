#!/usr/bin/env node
/**
 * Sends an interactive SAS verification request from an existing bot account
 * to a Matrix user. This is useful after re-creating the bridge device from an
 * imported bot blob: the bot can sign its own device, but the human user still
 * needs to trust the bot user's cross-signing identity.
 *
 * Usage:
 *   node verify-existing-bot.mjs --user @alice:example.org
 *
 * Environment:
 *   MATRIX_HOMESERVER_URL
 *   MATRIX_BOT_USER_ID
 *   MATRIX_BOT_PASSWORD
 *   MATRIX_BOT_RECOVERY_KEY
 */

import dotenv from 'dotenv';
dotenv.config();

import * as sdk from 'matrix-js-sdk';
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/recovery-key.js';
import { UserId } from '@matrix-org/matrix-sdk-crypto-wasm';
import { VerificationPhase, VerificationRequestEvent, VerifierEvent } from 'matrix-js-sdk/lib/crypto-api/verification.js';

const HOMESERVER = process.env.MATRIX_HOMESERVER_URL || 'http://localhost:6167';
const BOT_USER_ID = process.env.MATRIX_BOT_USER_ID;
const BOT_PASSWORD = process.env.MATRIX_BOT_PASSWORD;
const BOT_RECOVERY_KEY = process.env.MATRIX_BOT_RECOVERY_KEY;
const VERIFY_TIMEOUT_MS = 5 * 60 * 1000;

const origLog = console.log;
const suppressed = /matrix_sdk_crypto|FetchHttpApi|key backup|push rule|Olm|crypto-sdk|CryptoStore|outgoing request|^\[Perf\]|receiveSyncChanges|Sync|saved sync|queued to-device|client options|Getting|Got |Prepare|Sending|Storing|Resuming|Attempting|Fetched|Adding default|cross signing|Secret storage|^INFO |^Checking|^Completed|^bootstrap|^Downloading|^Token no|^\/sync error|^Failed to proc/;
console.warn = (...a) => { if (!suppressed.test(String(a[0]))) origLog(...a); };
console.log = (...a) => { if (!suppressed.test(String(a[0]))) origLog(...a); };
console.debug = () => {};
function log(...a) { origLog(...a); }

function parseArgs() {
  const args = process.argv.slice(2);
  let userId;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user') userId = args[++i];
  }
  if (!userId) {
    console.error('Usage: node verify-existing-bot.mjs --user @user:host');
    process.exit(64);
  }
  if (!BOT_USER_ID || !BOT_PASSWORD || !BOT_RECOVERY_KEY) {
    console.error('Missing MATRIX_BOT_USER_ID, MATRIX_BOT_PASSWORD, or MATRIX_BOT_RECOVERY_KEY');
    process.exit(64);
  }
  return { userId };
}

async function loginAndSync() {
  const localpart = BOT_USER_ID.replace(/^@/, '').split(':')[0];
  const loginClient = sdk.createClient({ baseUrl: HOMESERVER });
  const loginResp = await loginClient.login('m.login.password', {
    identifier: { type: 'm.id.user', user: localpart },
    password: BOT_PASSWORD,
  });

  let decodedKey;
  const client = sdk.createClient({
    baseUrl: HOMESERVER,
    accessToken: loginResp.access_token,
    userId: loginResp.user_id,
    deviceId: loginResp.device_id,
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
  await new Promise(r => setTimeout(r, 2000));

  await cryptoApi.bootstrapSecretStorage({});
  await cryptoApi.bootstrapCrossSigning({
    authUploadDeviceSigningKeys: async (makeRequest) => makeRequest({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: loginResp.user_id },
      password: BOT_PASSWORD,
    }),
  });

  return { client, cryptoApi, loginResp };
}

async function findOrCreateDM(client, userId) {
  for (const room of client.getRooms()) {
    const members = room.getMembers().map(m => m.userId);
    if (members.length === 2 && members.includes(userId) && members.includes(client.getUserId())) {
      return room.roomId;
    }
  }
  const created = await client.createRoom({
    is_direct: true,
    invite: [userId],
    preset: 'trusted_private_chat',
  });
  return created.room_id;
}

async function ensureUserIdentityKnown(cryptoApi, userId, accessToken) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await cryptoApi.userHasCrossSigningKeys(userId, true);
    let identity = await cryptoApi.olmMachine.getIdentity(new UserId(userId));
    if (identity) return;

    const queryResp = await fetch(`${HOMESERVER}/_matrix/client/v3/keys/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_keys: { [userId]: [] } }),
    });
    await cryptoApi.olmMachine.markRequestAsSent('keys-query', attempt, JSON.stringify(await queryResp.json()));
    identity = await cryptoApi.olmMachine.getIdentity(new UserId(userId));
    if (identity) return;

    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Could not find cross-signing identity for ${userId}`);
}

async function sendVerificationAndAwait(client, cryptoApi, userId, accessToken) {
  const dmRoomId = await findOrCreateDM(client, userId);
  await ensureUserIdentityKnown(cryptoApi, userId, accessToken);
  const request = await cryptoApi.requestVerificationDM(userId, dmRoomId);
  log(`Verification request sent to ${userId}`);
  log('Open Element, accept the verification request from the bot, and confirm the emoji match.');

  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (Date.now() - start > VERIFY_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error(`Verification timed out after ${VERIFY_TIMEOUT_MS / 1000}s`));
        return;
      }
      if (request.phase === VerificationPhase.Done) {
        clearInterval(timer);
        resolve();
      } else if (request.phase === VerificationPhase.Cancelled) {
        clearInterval(timer);
        reject(new Error('Verification cancelled: ' + (request.cancellationCode || 'unknown')));
      }
    }, 1000);

    let verifierBound = false;
    request.on(VerificationRequestEvent.Change, () => {
      if (request.phase === VerificationPhase.Done) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (request.phase === VerificationPhase.Cancelled) {
        clearInterval(timer);
        reject(new Error('Verification cancelled: ' + (request.cancellationCode || 'unknown')));
        return;
      }

      const verifier = request.verifier;
      if (verifier && !verifierBound) {
        verifierBound = true;
        verifier.on(VerifierEvent.ShowSas, async (sas) => {
          log('SAS emoji available; auto-confirming on bot side.');
          try {
            await sas.confirm();
          } catch (e) {
            log('SAS confirm error: ' + e.message);
          }
        });
        verifier.verify().catch((e) => {
          if (String(e?.message || '').toLowerCase().includes('cancel')) return;
          reject(e);
        });
      }
    });
  });
}

async function main() {
  const { userId } = parseArgs();
  log(`Logging in as ${BOT_USER_ID}`);
  const { client, cryptoApi, loginResp } = await loginAndSync();
  try {
    await sendVerificationAndAwait(client, cryptoApi, userId, loginResp.access_token);
    log('Verification complete.');
  } finally {
    client.stopClient();
    await new Promise(r => setTimeout(r, 1000));
    await fetch(`${HOMESERVER}/_matrix/client/v3/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${loginResp.access_token}`, 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => {});
  }
}

main().catch(e => { console.error('Failed:', e); process.exit(1); });
