#!/usr/bin/env node
/**
 * verify-respond.mjs — Bot-side responder for USER-initiated verification.
 *
 * Two modes:
 *   - default: log in, wait for an incoming verification request, run SAS.
 *   - --rotate-and-sign <bridge-device-id> <new-recovery-key-out-path>:
 *     also resets the bot's SSSS + cross-signing identity in-process AND
 *     cross-signs the long-lived bridge device with the new self-signing
 *     key. The fresh recovery key is written to the given output file.
 *     This is needed when prior bootstrap runs rotated the identity but
 *     never re-cross-signed the bridge device — symptom is Element
 *     refusing to share megolm keys to the bridge ("Can't find the room
 *     key to decrypt the event").
 *
 * Usage:
 *   HOMESERVER=https://matrix.example.com \
 *     node verify-respond.mjs <bot-username> --password <pw> \
 *       [--rotate-and-sign <bridge-device-id> <recovery-key-out-file>] \
 *       [--timeout-ms <ms>]
 */

import * as sdk from 'matrix-js-sdk';
import { VerificationPhase, VerificationRequestEvent, VerifierEvent } from 'matrix-js-sdk/lib/crypto-api/verification.js';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api/CryptoEvent.js';
import { writeFileSync } from 'fs';

const HOMESERVER = process.env.HOMESERVER || process.env.MATRIX_HOMESERVER_URL;
if (!HOMESERVER) {
  console.error('HOMESERVER env var is required (e.g. https://matrix.example.com)');
  process.exit(1);
}

// Silence matrix-js-sdk's chatty logger (named export shape varies by
// version — guard so the script keeps working if the helper isn't there).
try { sdk.logger?.setLevel?.(sdk.logger?.levels?.ERROR ?? 4); } catch (_) { /* ignore */ }

function parseArgs() {
  const args = process.argv.slice(2);
  let username = null;
  let password = null;
  let timeoutMs = 5 * 60 * 1000;
  let bridgeDeviceId = null;
  let recoveryKeyOut = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--password') password = args[++i];
    else if (args[i] === '--timeout-ms') timeoutMs = parseInt(args[++i], 10);
    else if (args[i] === '--rotate-and-sign') {
      bridgeDeviceId = args[++i];
      recoveryKeyOut = args[++i];
    }
    else if (!username) username = args[i];
  }
  if (!username || !password) {
    console.error('Usage: node verify-respond.mjs <bot-username> --password <pw> [--rotate-and-sign <bridge-device-id> <recovery-key-out-file>] [--timeout-ms <ms>]');
    process.exit(2);
  }
  // Both positional args after --rotate-and-sign are required: without the
  // output path we'd still rotate (destroying the old SSSS key) but silently
  // throw the new recovery key away, leaving secret storage permanently
  // locked behind an unrecoverable key.
  if (bridgeDeviceId && !recoveryKeyOut) {
    console.error('--rotate-and-sign requires BOTH <bridge-device-id> and <recovery-key-out-file>. Refusing to rotate without somewhere to write the new key.');
    process.exit(2);
  }
  return { username, password, timeoutMs, bridgeDeviceId, recoveryKeyOut };
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

  // Cache for the SSSS key minted during rotate-and-sign; bootstrapCrossSigning
  // reads it back via getSecretStorageKey when storing the new private keys.
  const ssssKeyCache = { keyId: null, privateKey: null };
  const client = sdk.createClient({
    baseUrl: HOMESERVER,
    accessToken: loginData.access_token,
    userId: loginData.user_id,
    deviceId: loginData.device_id,
    cryptoCallbacks: {
      // Fall back to `Object.keys(keys)[0]` when the cache hasn't been
      // populated yet — the SDK can call getSecretStorageKey during
      // bootstrapSecretStorage *before* cacheSecretStorageKey fires,
      // and returning null there breaks the bootstrap. Matches the
      // pattern in add-bot.mjs / setup-user.mjs / verify-bots.mjs.
      getSecretStorageKey: async ({ keys }) => {
        if (!ssssKeyCache.privateKey) return null;
        const keyId = ssssKeyCache.keyId || Object.keys(keys)[0];
        if (!keyId || !keys[keyId]) return null;
        return [keyId, ssssKeyCache.privateKey];
      },
      cacheSecretStorageKey: (keyId, _keyInfo, privateKey) => {
        ssssKeyCache.keyId = keyId;
        ssssKeyCache.privateKey = privateKey;
      },
    },
  });
  client._ssssKeyCache = ssssKeyCache;
  await client.initRustCrypto({ useIndexedDB: false });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Sync timeout')), 30000);
    client.once(sdk.ClientEvent.Sync, (state) => {
      clearTimeout(t);
      if (state === 'PREPARED' || state === 'SYNCING') resolve();
      else reject(new Error('Sync: ' + state));
    });
    client.startClient({ initialSyncLimit: 0 });
  });
  await new Promise(r => setTimeout(r, 1500));
  return { client, loginData };
}

function attachVerifier(verifier) {
  verifier.on(VerifierEvent.ShowSas, async (sas) => {
    console.log('  -> SAS emoji available; auto-confirming on bot side.');
    console.log('     (You still need to tap "match" / "confirm" in Element to finish.)');
    try {
      await sas.confirm();
    } catch (e) {
      console.error('  SAS confirm error:', e.message);
    }
  });
}

async function waitForIncomingVerification(client, timeoutMs) {
  const userId = client.getUserId();
  console.log(`Listening for incoming verification requests for ${userId}…`);
  console.log(`In Element: open the bot's profile or any DM with the bot, then tap Verify.`);

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`No verification request received within ${timeoutMs / 1000}s.`));
    }, timeoutMs);

    const onRequest = async (request) => {
      console.log(`  -> Verification request received from ${request.otherUserId} (transaction ${request.transactionId})`);
      try {
        await request.accept();
        console.log('  -> Accepted verification request; waiting for SAS phase.');
      } catch (e) {
        clearTimeout(deadline);
        reject(new Error('Failed to accept verification: ' + e.message));
        return;
      }

      let verifierBound = false;
      const onChange = () => {
        const phase = request.phase;
        if (phase === VerificationPhase.Done) {
          clearTimeout(deadline);
          console.log('  -> Verification complete.');
          resolve();
          return;
        }
        if (phase === VerificationPhase.Cancelled) {
          clearTimeout(deadline);
          reject(new Error('Verification cancelled: ' + (request.cancellationCode || 'unknown')));
          return;
        }
        const verifier = request.verifier;
        if (verifier && !verifierBound) {
          verifierBound = true;
          attachVerifier(verifier);
          try {
            verifier.verify().catch((err) => {
              if (request.phase !== VerificationPhase.Done && request.phase !== VerificationPhase.Cancelled) {
                clearTimeout(deadline);
                reject(new Error('Verifier failed: ' + err.message));
              }
            });
          } catch (e) {
            clearTimeout(deadline);
            reject(new Error('Verifier kickoff threw: ' + e.message));
          }
        }
      };
      request.on(VerificationRequestEvent.Change, onChange);
      onChange();
    };

    client.on(CryptoEvent.VerificationRequestReceived, onRequest);
  });
}

async function rotateAndSignBridgeDevice(client, password, loginData, bridgeDeviceId, recoveryKeyOut) {
  const cryptoApi = client.getCrypto();

  console.log(`Rotating SSSS + cross-signing identity, then signing bridge device ${bridgeDeviceId}…`);
  let recoveryKey = null;
  await cryptoApi.bootstrapSecretStorage({
    setupNewSecretStorage: true,
    setupNewKeyBackup: false,
    createSecretStorageKey: async () => {
      const keyInfo = await cryptoApi.createRecoveryKeyFromPassphrase();
      recoveryKey = keyInfo.encodedPrivateKey;
      // Pre-populate the cache so getSecretStorageKey returns this key on
      // the next call (bootstrapCrossSigning writes the new private keys
      // to SSSS, encrypted with this key).
      if (client._ssssKeyCache) {
        client._ssssKeyCache.privateKey = keyInfo.privateKey;
      }
      return keyInfo;
    },
  });
  // After bootstrapSecretStorage, the new keyId is the default — fetch it.
  if (client._ssssKeyCache && !client._ssssKeyCache.keyId) {
    const defaultKeyId = await client.secretStorage?.getDefaultKeyId?.();
    if (defaultKeyId) client._ssssKeyCache.keyId = defaultKeyId;
  }
  await cryptoApi.bootstrapCrossSigning({
    setupNewCrossSigning: true,
    authUploadDeviceSigningKeys: async (makeRequest) => makeRequest({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: loginData.user_id },
      password,
    }),
  });
  console.log('  Cross-signing rotated. Waiting briefly for /keys/upload to flush…');
  await new Promise(r => setTimeout(r, 2000));

  // Confirm the bridge device is known to the homeserver
  const devices = await cryptoApi.getUserDeviceInfo([loginData.user_id]);
  const ours = devices.get(loginData.user_id);
  if (!ours || !ours.has(bridgeDeviceId)) {
    const known = ours ? Array.from(ours.keys()) : [];
    throw new Error(`Bridge device ${bridgeDeviceId} not visible on server. Known devices: ${known.join(', ') || '(none)'}`);
  }
  await cryptoApi.crossSignDevice(bridgeDeviceId);
  console.log(`  Bridge device ${bridgeDeviceId} cross-signed.`);

  if (recoveryKey && recoveryKeyOut) {
    // Atomically create with 0o600 so the key is never world-readable, even
    // briefly. Matches add-bot.mjs.
    writeFileSync(recoveryKeyOut, recoveryKey + '\n', { mode: 0o600 });
    console.log(`  New recovery key written to ${recoveryKeyOut} (mode 0600).`);
    console.log('  Update the Chef credentials data bag with this value.');
  }
}

async function main() {
  const { username, password, timeoutMs, bridgeDeviceId, recoveryKeyOut } = parseArgs();
  console.log(`Logging bot @${username} into ${HOMESERVER} (creates a temporary device).`);
  const { client, loginData } = await loginAndSync(username, password);
  console.log(`  device ${loginData.device_id} ready.`);

  try {
    if (bridgeDeviceId) {
      await rotateAndSignBridgeDevice(client, password, loginData, bridgeDeviceId, recoveryKeyOut);
    }
    await waitForIncomingVerification(client, timeoutMs);
    console.log('Done. The bot user is now SAS-trusted by your Element session.');
    if (bridgeDeviceId) {
      console.log(`Bridge device ${bridgeDeviceId} should now receive megolm keys from your client.`);
    }
  } finally {
    try {
      await fetch(`${HOMESERVER}/_matrix/client/v3/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${loginData.access_token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch (_) {
      // best effort
    }
    client.stopClient();
    setTimeout(() => process.exit(0), 500);
  }
}

main().catch(err => {
  console.error('Failed:', err.message || err);
  process.exit(1);
});
