#!/usr/bin/env node
/**
 * Sets up a new Matrix user account with cross-signing and verifies the bot users.
 *
 * Creates the user, bootstraps secret storage + cross-signing, and cross-signs
 * the bot users so they show as verified in Element from the first login.
 *
 * Credentials are written to a file on disk (not printed to stdout).
 *
 * Usage:
 *   node setup-user.mjs <username> [options]
 *
 * Options:
 *   --bot @bot:host           Cross-sign this bot from the user side. Repeatable.
 *   --password <pw>           Use this password for the user (default: random hex).
 *   --credentials-file <path> Where to write the credentials file
 *                             (default: ~/.matrix-user-<username>-credentials).
 *
 * Environment:
 *   MATRIX_HOMESERVER_URL  — Homeserver URL (default: from .env)
 *   REG_TOKEN              — Registration token (required if registration is token-gated)
 */

import dotenv from 'dotenv';
dotenv.config();

import * as sdk from 'matrix-js-sdk';
import { UserId } from '@matrix-org/matrix-sdk-crypto-wasm';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOMESERVER = process.env.MATRIX_HOMESERVER_URL || 'http://localhost:6167';
const REG_TOKEN = process.env.REG_TOKEN || '';

const origLog = console.log;
const suppressed = /matrix_sdk_crypto|FetchHttpApi|key backup|push rule|Olm|crypto-sdk|CryptoStore|outgoing request|^\[Perf\]|receiveSyncChanges|Sync|saved sync|queued to-device|client options|Getting|Got |Prepare|Sending|Storing|Resuming|Attempting|Fetched|Adding default|cross signing|Secret storage|^INFO |^Checking|^Completed|^bootstrap|^Downloading|^Token no|^\/sync error|^Failed to proc/;
console.warn = (...a) => { if (!suppressed.test(String(a[0]))) origLog(...a); };
console.log = (...a) => { if (!suppressed.test(String(a[0]))) origLog(...a); };
console.debug = () => {};
function log(...a) { origLog(...a); }

function parseArgs() {
    const args = process.argv.slice(2);
    if (!args.length || args[0].startsWith('-')) {
        console.error('Usage: node setup-user.mjs <username> [--bot @user:host ...] [--password <pw>] [--credentials-file <path>]');
        process.exit(1);
    }
    const username = args[0];
    const bots = [];
    let password = null;
    let credentialsFile = null;
    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--bot' && args[i + 1]) {
            bots.push(args[++i]);
        } else if (args[i] === '--password' && args[i + 1]) {
            password = args[++i];
        } else if (args[i] === '--credentials-file' && args[i + 1]) {
            credentialsFile = args[++i];
        }
    }
    return { username, bots, password, credentialsFile };
}

async function register(username, password) {
    const authBase = REG_TOKEN
        ? { type: 'm.login.registration_token', token: REG_TOKEN }
        : { type: 'm.login.dummy' };

    let resp = await fetch(`${HOMESERVER}/_matrix/client/v3/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, auth: authBase, inhibit_login: true }),
    });
    let data = await resp.json();

    if (data.session) {
        resp = await fetch(`${HOMESERVER}/_matrix/client/v3/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username, password,
                auth: { ...authBase, session: data.session },
                inhibit_login: true,
            }),
        });
        data = await resp.json();
    }
    return data;
}

async function main() {
    const { username, bots, password: cliPassword, credentialsFile: cliCredentialsFile } = parseArgs();
    const password = cliPassword || crypto.randomBytes(16).toString('hex');

    log(`Setting up user @${username} on ${HOMESERVER}`);
    if (bots.length) log(`Will cross-sign: ${bots.join(', ')}`);

    // Step 1: Register
    log('Step 1: Register');
    const regResult = await register(username, password);
    if (regResult.user_id) {
        log(`  Registered ${regResult.user_id}`);
    } else if (regResult.errcode === 'M_USER_IN_USE') {
        log('  ERROR: User already exists. Choose a different username.');
        process.exit(1);
    } else {
        log('  ERROR:', JSON.stringify(regResult));
        process.exit(1);
    }

    // Step 2: Login
    log('Step 2: Login');
    const loginResp = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: regResult.user_id },
            password,
        }),
    });
    const loginData = await loginResp.json();

    // Step 3: Set up crypto
    log('Step 3: Crypto setup');
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

    // Secret storage first, then cross-signing
    log('Step 4: Secret storage + cross-signing');
    await cryptoApi.bootstrapSecretStorage({
        createSecretStorageKey: async () => {
            const keyInfo = await client.createRecoveryKeyFromPassphrase();
            recoveryKey = keyInfo.encodedPrivateKey;
            secretKey.privateKey = keyInfo.privateKey;
            return keyInfo;
        },
        setupNewSecretStorage: true,
        setupNewKeyBackup: false,
    });
    log('  Secret storage ready');

    await cryptoApi.bootstrapCrossSigning({
        authUploadDeviceSigningKeys: async (makeRequest) => {
            return makeRequest({
                type: 'm.login.password',
                identifier: { type: 'm.id.user', user: loginData.user_id },
                password,
            });
        },
    });
    log('  Cross-signing ready');

    // Step 5: Cross-sign bots
    for (const botUserId of bots) {
        log(`Step 5: Cross-signing ${botUserId}`);
        const machine = cryptoApi.olmMachine;
        let identity = await machine.getIdentity(new UserId(botUserId));
        if (!identity) {
            const queryResp = await fetch(`${HOMESERVER}/_matrix/client/v3/keys/query`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${loginData.access_token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_keys: { [botUserId]: [] } }),
            });
            await machine.markRequestAsSent('keys-query', 1, JSON.stringify(await queryResp.json()));
            await new Promise(r => setTimeout(r, 1000));
            identity = await machine.getIdentity(new UserId(botUserId));
        }
        if (!identity) { log(`  ERROR: no identity for ${botUserId}`); continue; }

        const request = await identity.verify();
        const uploadResp = await fetch(`${HOMESERVER}/_matrix/client/v3/keys/signatures/upload`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${loginData.access_token}`, 'Content-Type': 'application/json' },
            body: request.body,
        });
        const result = await uploadResp.json();
        log(`  ${Object.keys(result.failures || {}).length === 0 ? 'OK' : 'FAILED: ' + JSON.stringify(result.failures)}`);
    }

    // Logout the setup device
    await new Promise(r => setTimeout(r, 1000));
    await fetch(`${HOMESERVER}/_matrix/client/v3/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${loginData.access_token}`, 'Content-Type': 'application/json' },
        body: '{}',
    });

    // Write credentials to file. Shell-quote so the file is safe to `source`
    // from bash (matrix-user-setup.sh reads recovery_key + password back out).
    const credsFile = cliCredentialsFile || path.join(os.homedir(), `.matrix-user-${username}-credentials`);
    const sq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
    const creds = [
        `user_id=${sq(regResult.user_id)}`,
        `password=${sq(password)}`,
        `recovery_key=${sq(recoveryKey)}`,
        `homeserver=${sq(HOMESERVER)}`,
    ].join('\n') + '\n';
    fs.writeFileSync(credsFile, creds, { mode: 0o600 });

    log('');
    log('=== SETUP COMPLETE ===');
    log(`Credentials written to: ${credsFile}`);
    log(`User: ${regResult.user_id}`);
    log('Read the credentials file on the server to get password and recovery key.');

    process.exit(0);
}

main().catch(e => { console.error('Failed:', e); process.exit(1); });
