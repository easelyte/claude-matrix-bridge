#!/usr/bin/env node
/**
 * Cross-signs bot users from an existing user account.
 *
 * Uses the user's recovery key to access their user-signing key, then signs
 * each bot's cross-signing master key and uploads the signature to the server.
 *
 * Usage:
 *   node verify-bots.mjs --recovery-key-file ~/.matrix-recovery-key \
 *     --user @alice:matron.chat --password <pass> \
 *     --bot @dev-2:matron.chat --bot @dev-3:matron.chat
 *
 * Environment (used as defaults):
 *   MATRIX_HOMESERVER_URL  — Homeserver URL (default: from .env)
 */

import dotenv from 'dotenv';
dotenv.config();

import * as sdk from 'matrix-js-sdk';
import { UserId } from '@matrix-org/matrix-sdk-crypto-wasm';
import { readFileSync } from 'fs';

const HOMESERVER = process.env.MATRIX_HOMESERVER_URL || 'http://localhost:6167';

const origLog = console.log;
const suppressed = /matrix_sdk_crypto|FetchHttpApi|key backup|push rule|Olm|crypto-sdk|CryptoStore|outgoing request|^\[Perf\]|receiveSyncChanges|Sync|saved sync|queued to-device|client options|Getting|Got |Prepare|Sending|Storing|Resuming|Attempting|Fetched|Adding default|cross signing|Secret storage|^INFO |^Checking|^Completed|^bootstrap|^Downloading|^Token no|^\/sync error|^Failed to proc/;
console.warn = (...a) => { if (!suppressed.test(String(a[0]))) origLog(...a); };
console.log = (...a) => { if (!suppressed.test(String(a[0]))) origLog(...a); };
console.debug = () => {};
function log(...a) { origLog(...a); }

function parseArgs() {
    const args = process.argv.slice(2);
    let user, password, recoveryKeyFile;
    const bots = [];

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--user': user = args[++i]; break;
            case '--password': password = args[++i]; break;
            case '--recovery-key-file': recoveryKeyFile = args[++i]; break;
            case '--bot': bots.push(args[++i]); break;
        }
    }

    if (!user || !password || !recoveryKeyFile || !bots.length) {
        console.error('Usage: node verify-bots.mjs --user @user:host --password <pass> --recovery-key-file <path> --bot @bot:host [--bot ...]');
        process.exit(1);
    }

    const recoveryKey = readFileSync(recoveryKeyFile, 'utf-8').trim();
    return { user, password, recoveryKey, bots };
}

async function main() {
    const { user, password, recoveryKey, bots } = parseArgs();

    log(`Verifying ${bots.length} bot(s) from ${user}`);

    for (const botUserId of bots) {
        log(`\n--- Cross-signing ${botUserId} ---`);

        const loginClient = sdk.createClient({ baseUrl: HOMESERVER });
        const loginResp = await loginClient.login('m.login.password', {
            identifier: { type: 'm.id.user', user },
            password,
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
                    if (!decodedKey) decodedKey = client.keyBackupKeyFromRecoveryKey(recoveryKey);
                    return [keyId, decodedKey];
                },
            },
        });

        await client.initRustCrypto({ useIndexedDB: false });
        const crypto = client.getCrypto();

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

        await crypto.bootstrapCrossSigning({
            authUploadDeviceSigningKeys: async (makeRequest) => {
                return makeRequest({
                    type: 'm.login.password',
                    identifier: { type: 'm.id.user', user: loginResp.user_id },
                    password,
                });
            },
        });

        const machine = crypto.olmMachine;
        let identity = await machine.getIdentity(new UserId(botUserId));
        if (!identity) {
            log('  Querying server for bot keys...');
            const queryResp = await fetch(`${HOMESERVER}/_matrix/client/v3/keys/query`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${loginResp.access_token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_keys: { [botUserId]: [] } }),
            });
            await machine.markRequestAsSent('keys-query', 1, JSON.stringify(await queryResp.json()));
            await new Promise(r => setTimeout(r, 1000));
            identity = await machine.getIdentity(new UserId(botUserId));
        }

        if (!identity) {
            log('  ERROR: Could not get bot identity');
            continue;
        }

        const request = await identity.verify();
        const uploadResp = await fetch(`${HOMESERVER}/_matrix/client/v3/keys/signatures/upload`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${loginResp.access_token}`, 'Content-Type': 'application/json' },
            body: request.body,
        });
        const result = await uploadResp.json();
        const ok = Object.keys(result.failures || {}).length === 0;
        log(`  ${ok ? 'OK — signature uploaded' : 'FAILED: ' + JSON.stringify(result.failures)}`);

        await new Promise(r => setTimeout(r, 1000));
        await fetch(`${HOMESERVER}/_matrix/client/v3/logout`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${loginResp.access_token}`, 'Content-Type': 'application/json' },
            body: '{}',
        });
    }

    log('\nDone');
    process.exit(0);
}

main().catch(e => { console.error('Failed:', e); process.exit(1); });
