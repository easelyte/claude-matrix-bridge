#!/usr/bin/env node
/**
 * Bootstrap cross-signing for the Matrix bot user.
 *
 * Creates cross-signing keys (master, self-signing, user-signing) and signs
 * the bot-sdk's device so Element shows it as verified.
 *
 * Usage:
 *   BOT_PASSWORD=xxx node bootstrap-crosssigning.mjs [--device-id DEVICE_ID]
 *
 * Environment:
 *   MATRIX_HOMESERVER_URL  — Homeserver URL (default: from .env)
 *   MATRIX_ACCESS_TOKEN    — Bot access token (used to find user ID; default: from .env)
 *   BOT_PASSWORD           — Bot's password (required for UIA auth)
 *
 * Options:
 *   --device-id ID  — Device ID of the bot-sdk device to cross-sign
 *                     (auto-detected from crypto store if not specified)
 *
 * The bridge service should be stopped before running this to avoid
 * crypto store conflicts.
 */

import dotenv from 'dotenv';
dotenv.config();

import * as sdk from 'matrix-js-sdk';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

// Suppress noisy debug/info output from Rust SDK and matrix-js-sdk internals
const origWarn = console.warn;
const origLog = console.log;
const origDebug = console.debug;
const suppressed = /matrix_sdk_crypto|FetchHttpApi|key backup|push rule|Olm|crypto-sdk|CryptoStore|outgoing request|^\[Perf\]|receiveSyncChanges|Sync|saved sync|queued to-device|client options|Getting|Got |Prepare|Sending|Storing|Resuming|Attempting|Fetched|Adding default|cross signing identity|resetCrossSigning|bootstrapCrossSigning:|Secret storage|^INFO /;
console.warn = (...a) => { if (!suppressed.test(String(a[0]))) origWarn(...a); };
console.log = (...a) => { if (!suppressed.test(String(a[0]))) origLog(...a); };
console.debug = () => {};
function log(...a) { origLog(...a); }

// --- Parse args ---

const args = process.argv.slice(2);
let explicitDeviceId = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--device-id' && args[i + 1]) {
    explicitDeviceId = args[i + 1];
    i++;
  }
}

// --- Config ---

const HOMESERVER_URL = process.env.MATRIX_HOMESERVER_URL;
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const BOT_PASSWORD = process.env.BOT_PASSWORD;

if (!HOMESERVER_URL) {
  console.error('MATRIX_HOMESERVER_URL is required (set in .env or environment)');
  process.exit(1);
}
if (!BOT_PASSWORD) {
  console.error('BOT_PASSWORD is required');
  process.exit(1);
}

// --- Detect bot-sdk device ID ---

function detectBotDeviceId() {
  const stateFile = path.join(os.homedir(), '.claude-matrix-bot-crypto', 'bot-sdk.json');
  if (!existsSync(stateFile)) return null;
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    return state.deviceId || null;
  } catch {
    return null;
  }
}

// --- Detect bot user ID ---

async function getBotUserId() {
  if (!ACCESS_TOKEN) return null;
  try {
    const resp = await fetch(`${HOMESERVER_URL}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    const data = await resp.json();
    return data.user_id || null;
  } catch {
    return null;
  }
}

// --- Main ---

async function main() {
  const botDeviceId = explicitDeviceId || detectBotDeviceId();
  const botUserId = await getBotUserId();

  if (!botUserId) {
    console.error('Could not determine bot user ID. Set MATRIX_ACCESS_TOKEN in .env');
    process.exit(1);
  }

  log(`Bot user:      ${botUserId}`);
  log(`Bot device:    ${botDeviceId || '(none detected)'}`);
  log(`Homeserver:    ${HOMESERVER_URL}`);
  log('');

  // Step 1: Login with password to create a temporary device
  log('Step 1: Logging in with password (temporary device)...');
  const loginClient = sdk.createClient({ baseUrl: HOMESERVER_URL });

  let loginResp;
  try {
    loginResp = await loginClient.login('m.login.password', {
      identifier: { type: 'm.id.user', user: botUserId },
      password: BOT_PASSWORD,
    });
  } catch (err) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }

  log(`  Temp device: ${loginResp.device_id}`);

  // Step 2: Create a proper client with the new credentials
  const matrixClient = sdk.createClient({
    baseUrl: HOMESERVER_URL,
    accessToken: loginResp.access_token,
    userId: loginResp.user_id,
    deviceId: loginResp.device_id,
  });

  // Step 3: Initialize Rust crypto
  log('Step 2: Initializing crypto...');
  await matrixClient.initRustCrypto({ useIndexedDB: false });

  const crypto = matrixClient.getCrypto();

  // Step 4: Start sync and wait for it to be ready
  // This processes outgoing requests (keys/upload, keys/query) which the crypto
  // module needs before we can bootstrap cross-signing.
  log('Step 3: Syncing to exchange device keys...');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Sync timed out after 30 seconds'));
    }, 30000);

    matrixClient.once(sdk.ClientEvent.Sync, (state) => {
      clearTimeout(timeout);
      if (state === 'PREPARED' || state === 'SYNCING') {
        resolve();
      } else {
        reject(new Error(`Sync failed with state: ${state}`));
      }
    });

    matrixClient.startClient({ initialSyncLimit: 0 });
  });
  log('  Sync ready.');

  // Brief delay to let outgoing crypto requests complete
  await new Promise(r => setTimeout(r, 2000));

  // Step 5: Bootstrap cross-signing
  log('Step 4: Bootstrapping cross-signing...');
  try {
    await crypto.bootstrapCrossSigning({
      authUploadDeviceSigningKeys: async (makeRequest) => {
        return makeRequest({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: loginResp.user_id },
          password: BOT_PASSWORD,
        });
      },
    });
    log('  Cross-signing keys uploaded.');
  } catch (err) {
    // If cross-signing already exists, that's fine
    if (err.message?.includes('already exists') || err.message?.includes('already set up')) {
      log('  Cross-signing already set up.');
    } else {
      throw err;
    }
  }

  // Step 6: Cross-sign the bot-sdk device
  if (botDeviceId && botDeviceId !== loginResp.device_id) {
    log(`Step 5: Cross-signing bot device ${botDeviceId}...`);

    // Fetch fresh device info
    const devices = await crypto.getUserDeviceInfo([loginResp.user_id]);
    const userDevices = devices.get(loginResp.user_id);

    if (userDevices && userDevices.has(botDeviceId)) {
      try {
        await crypto.crossSignDevice(botDeviceId);
        log(`  Device ${botDeviceId} signed.`);
      } catch (err) {
        console.error(`  Failed to cross-sign device: ${err.message}`);
        console.error('  The device may need manual verification from Element.');
      }
    } else {
      const knownDevices = userDevices ? Array.from(userDevices.keys()) : [];
      log(`  Device ${botDeviceId} not found on server.`);
      log(`  Known devices: ${knownDevices.join(', ') || '(none)'}`);
      log('  The bot device will be signed on next bootstrap run after the bridge starts.');
    }
  } else if (!botDeviceId) {
    log('Step 5: No bot-sdk device detected — skipping device signing.');
  } else {
    log('Step 5: Bot device is the temp device — already signed by bootstrap.');
  }

  // Step 7: Show status
  const status = await crypto.getCrossSigningStatus();
  log('');
  log('Cross-signing status:');
  log(`  Keys on device: ${status.publicKeysOnDevice}`);
  const local = status.privateKeysCachedLocally;
  log(`  Master key:     ${local.masterKey ? 'yes' : 'no'}`);
  log(`  Self-signing:   ${local.selfSigningKey ? 'yes' : 'no'}`);
  log(`  User-signing:   ${local.userSigningKey ? 'yes' : 'no'}`);

  // Step 8: Stop client and log out
  log('');
  log('Cleaning up...');
  matrixClient.stopClient();

  // Give background tasks a moment to settle
  await new Promise(r => setTimeout(r, 1000));

  try {
    // Use raw HTTP to log out since the client is stopped
    await fetch(`${HOMESERVER_URL}/_matrix/client/v3/logout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${loginResp.access_token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    log('  Temp device logged out.');
  } catch {
    log('  Logout request failed (device will expire on its own).');
  }

  log('');
  log('Cross-signing bootstrap complete!');
  if (botDeviceId) {
    log('');
    log('Next steps:');
    log('  1. Restart the bridge: sudo systemctl restart claude-matrix-bridge');
    log('  2. In Element, verify the bot user to trust its cross-signing key');
  }
  log('');

  process.exit(0);
}

main().catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
