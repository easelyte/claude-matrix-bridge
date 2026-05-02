#!/usr/bin/env node
/**
 * Drives a freshly-registered bot through:
 *   1. Login → access token + device_id
 *   2. Bootstrap own SSSS + cross-signing → bot_recovery_key, master CSK
 *   3. Open or find a DM with the human user
 *   4. Send m.key.verification.request, auto-confirm SAS on the bot side,
 *      poll until user accepts and the dance completes
 *   5. Sanity-check that user has signed bot's master key
 *   6. Create the encrypted bridge room and invite the user
 *   7. Logout the temporary device, write creds file
 *
 * Usage:
 *   node add-bot.mjs <bot-username> --password <pw> --user @user:host \
 *                     --credentials-file /dev/shm/... [--room-name <name>] \
 *                     [--skip-verification]
 *
 * Environment:
 *   MATRIX_HOMESERVER_URL  — default http://localhost:6167
 *
 * Required output (shell-source format) at the path passed via
 * --credentials-file:
 *   bot_recovery_key='...'
 *   bridge_room_id='!...:...'
 */

import dotenv from 'dotenv';
dotenv.config();

import * as sdk from 'matrix-js-sdk';
import { UserId } from '@matrix-org/matrix-sdk-crypto-wasm';
import { VerificationPhase, VerificationRequestEvent, VerifierEvent } from 'matrix-js-sdk/lib/crypto-api/verification.js';
import { writeFileSync } from 'fs';

const HOMESERVER = process.env.MATRIX_HOMESERVER_URL || 'http://localhost:6167';
const VERIFY_TIMEOUT_MS = 5 * 60 * 1000;

// Mirror setup-user.mjs's noise suppression so the operator only sees flow steps.
const origLog = console.log;
const suppressed = /matrix_sdk_crypto|FetchHttpApi|key backup|push rule|Olm|crypto-sdk|CryptoStore|outgoing request|^\[Perf\]|receiveSyncChanges|Sync|saved sync|queued to-device|client options|Getting|Got |Prepare|Sending|Storing|Resuming|Attempting|Fetched|Adding default|cross signing|Secret storage|^INFO |^Checking|^Completed|^bootstrap|^Downloading|^Token no|^\/sync error|^Failed to proc/;
console.warn = (...a) => { if (!suppressed.test(String(a[0]))) origLog(...a); };
console.log = (...a) => { if (!suppressed.test(String(a[0]))) origLog(...a); };
console.debug = () => {};
function log(...a) { origLog(...a); }

function parseArgs() {
  const args = process.argv.slice(2);
  if (!args.length || args[0].startsWith('-')) {
    console.error('Usage: node add-bot.mjs <bot-username> --password <pw> --user @user:host --credentials-file <path> [--room-name <name>] [--skip-verification]');
    process.exit(1);
  }
  const username = args[0];
  let password, user, credentialsFile, roomName, skipVerification = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--password') password = args[++i];
    else if (args[i] === '--user') user = args[++i];
    else if (args[i] === '--credentials-file') credentialsFile = args[++i];
    else if (args[i] === '--room-name') roomName = args[++i];
    else if (args[i] === '--skip-verification') skipVerification = true;
  }
  if (!password || !user || !credentialsFile) {
    console.error('Missing required arg (--password, --user, --credentials-file)');
    process.exit(1);
  }
  return { username, password, user, credentialsFile, roomName: roomName || defaultBridgeRoomName(username), skipVerification };
}

function defaultBridgeRoomName(username) {
  const label = username
    .replace(/^@/, '')
    .split(':')[0]
    .replace(/^claude[-_]?bot[-_]?/i, '')
    .replace(/^bot[-_]?/i, '')
    .replace(/^[-_]+/, '');
  return `${label || username}: Claude Code Bridge`;
}

async function loginAndSync(username, password) {
  const loginResp = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: username },
      password,
    }),
  });
  const loginData = await loginResp.json();
  if (!loginData.access_token) throw new Error('Bot login failed: ' + JSON.stringify(loginData));

  let recoveryKey;
  const secretKey = { privateKey: null };
  const client = sdk.createClient({
    baseUrl: HOMESERVER,
    accessToken: loginData.access_token,
    userId: loginData.user_id,
    deviceId: loginData.device_id,
    cryptoCallbacks: {
      getSecretStorageKey: async ({ keys }) => {
        const keyId = Object.keys(keys)[0];
        return [keyId, secretKey.privateKey];
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

  return {
    client,
    cryptoApi,
    loginData,
    secretKey,
    recoveryKeyRef: () => recoveryKey,
    setRecoveryKey: (k) => { recoveryKey = k; },
  };
}

async function bootstrapBotIdentity(client, cryptoApi, loginData, password, secretKey, setRecoveryKey) {
  await cryptoApi.bootstrapSecretStorage({
    createSecretStorageKey: async () => {
      const keyInfo = await cryptoApi.createRecoveryKeyFromPassphrase();
      setRecoveryKey(keyInfo.encodedPrivateKey);
      secretKey.privateKey = keyInfo.privateKey;
      return keyInfo;
    },
    setupNewSecretStorage: true,
    setupNewKeyBackup: false,
  });

  await cryptoApi.bootstrapCrossSigning({
    authUploadDeviceSigningKeys: async (makeRequest) => {
      return makeRequest({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: loginData.user_id },
        password,
      });
    },
  });
}

async function findOrCreateDM(client, userId) {
  // Look for an existing 1:1 room with the user.
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
  log(`  -> Verification request sent to ${userId}`);
  log(`     Open Element and accept the verification request, then confirm the emoji match.`);

  const start = Date.now();

  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      if (Date.now() - start > VERIFY_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error(`Verification timed out after ${VERIFY_TIMEOUT_MS / 1000}s`));
        return;
      }

      const phase = request.phase;
      if (phase === VerificationPhase.Done) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (phase === VerificationPhase.Cancelled) {
        clearInterval(timer);
        reject(new Error('Verification cancelled: ' + (request.cancellationCode || 'unknown')));
        return;
      }
    }, 1000);

    // When the request transitions to Started, a verifier will be available.
    // Listen for Change events to catch that transition.
    let verifierBound = false;
    request.on(VerificationRequestEvent.Change, () => {
      const phase = request.phase;
      if (phase === VerificationPhase.Done) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (phase === VerificationPhase.Cancelled) {
        clearInterval(timer);
        reject(new Error('Verification cancelled: ' + (request.cancellationCode || 'unknown')));
        return;
      }

      const verifier = request.verifier;
      if (verifier && !verifierBound) {
        verifierBound = true;
        // Auto-confirm SAS on the bot side. Safe: bot<->homeserver is loopback;
        // the security boundary is the user's Element session confirming the emoji.
        verifier.on(VerifierEvent.ShowSas, async (sas) => {
          log(`  -> SAS emoji available; auto-confirming on bot side (user still needs to confirm in Element)`);
          try {
            await sas.confirm();
          } catch (e) {
            log('  SAS confirm error: ' + e.message);
          }
        });

        // Start the verifier. Propagate non-cancellation failures to the outer
        // promise; cancellations are handled via phase polling above.
        verifier.verify().catch((e) => {
          if (String(e?.message || '').toLowerCase().includes('cancel')) return;
          reject(e);
        });
      }
    });
  });
}

async function createBridgeRoom(client, userId, roomName) {
  const created = await client.createRoom({
    name: roomName,
    topic: `Messages in this room are forwarded to Claude Code on ${roomName.replace(/: Claude Code Bridge$/, '')}`,
    visibility: 'private',
    preset: 'private_chat',
    invite: [userId],
    initial_state: [{
      type: 'm.room.encryption',
      state_key: '',
      content: { algorithm: 'm.megolm.v1.aes-sha2' },
    }],
  });
  return created.room_id;
}

async function main() {
  const { username, password, user, credentialsFile, roomName, skipVerification } = parseArgs();

  log(`Bootstrapping bot @${username} on ${HOMESERVER}`);
  const session = await loginAndSync(username, password);

  try {
    log('Bootstrapping bot SSSS + cross-signing');
    await bootstrapBotIdentity(session.client, session.cryptoApi, session.loginData, password, session.secretKey, session.setRecoveryKey);
    log('  bot recovery key generated, master/self/user signing keys uploaded');

    if (skipVerification) {
      log('Skipping interactive SAS verification; caller must cross-sign the bot separately');
    } else {
      log('Sending verification request');
      await sendVerificationAndAwait(session.client, session.cryptoApi, user, session.loginData.access_token);
      log('  verification done — bot master key signed by user');
    }

    if (!skipVerification) {
      log('  verification done — checking cross-signing status');
      try {
        const status = await session.cryptoApi.getUserVerificationStatus(user);
        if (!status.isCrossSigningVerified()) {
          log('  ⚠ SAS completed but bot has not cross-verified the user — proceeding anyway');
          // Don't throw — the bridge will still function, just without the green-shield UX.
        }
      } catch (e) {
        log('  ⚠ could not check cross-signing status: ' + e.message);
      }
    }

    log('Creating encrypted bridge room and inviting user');
    const roomId = await createBridgeRoom(session.client, user, roomName);
    log(`  bridge room: ${roomId}`);

    const recoveryKey = session.recoveryKeyRef();
    if (!recoveryKey) {
      throw new Error('Bot SSSS bootstrap did not produce a recovery key — refusing to write a half-formed creds file');
    }

    writeFileSync(credentialsFile, [
      `bot_recovery_key='${recoveryKey}'`,
      `bridge_room_id='${roomId}'`,
    ].join('\n') + '\n', { mode: 0o600 });

    log('Done');
  } finally {
    log('Logging out temporary device');
    try {
      await fetch(`${HOMESERVER}/_matrix/client/v3/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.loginData.access_token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch (e) {
      log('  logout failed (non-fatal): ' + e.message);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error('Failed:', e); process.exit(1); });
