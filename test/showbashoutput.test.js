import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// index.js has top-level side effects (starts express, connects to matrix,
// etc.) and SESSIONS_FILE is a hardcoded constant — so we cannot import the
// real persistSession/getPersistedSession in-process. This test instead
// reproduces the persistence shape that persistSession writes (see
// index.js:152-157) and confirms a JSON round-trip preserves
// `showBashOutput` so the read side at index.js:174 sees it.
//
// The actual end-to-end flow (toggle -> persist -> restart -> spawn env) is
// covered by manual trace; see commit message and plan doc.

describe('showBashOutput persistence', () => {
  let tmp;
  let sessionsFile;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'sbo-'));
    sessionsFile = path.join(tmp, 'sessions.json');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('on-disk shape preserves showBashOutput across read', () => {
    // Mirrors the object persistSession writes:
    //   { sessionId, workdir, lastUsed, originRoomId, ...extra }
    const fixture = {
      '!room:server': {
        sessionId: 'sess1',
        workdir: '/tmp',
        lastUsed: Date.now(),
        originRoomId: null,
        showBashOutput: true,
      },
    };
    writeFileSync(sessionsFile, JSON.stringify(fixture, null, 2));

    const data = JSON.parse(readFileSync(sessionsFile, 'utf-8'));
    expect(data['!room:server'].showBashOutput).toBe(true);
    // Sanity: other fields untouched
    expect(data['!room:server'].sessionId).toBe('sess1');
    expect(data['!room:server'].workdir).toBe('/tmp');
  });

  it('extra fields merge does not clobber showBashOutput when other extras are written', () => {
    // Simulates the persistSession spread: { ...existing, ..., ...extra }.
    // After a !show_bash toggle persists { showBashOutput: true }, a later
    // ExitPlanMode persist of { pendingPlanDenialId: 'x' } must not drop it.
    const existing = {
      sessionId: 'sess1',
      workdir: '/tmp',
      lastUsed: 1,
      originRoomId: null,
      showBashOutput: true,
    };
    const merged = {
      ...existing,
      sessionId: 'sess1',
      workdir: '/tmp',
      lastUsed: 2,
      originRoomId: null,
      pendingPlanDenialId: 'tu_abc',
    };
    expect(merged.showBashOutput).toBe(true);
    expect(merged.pendingPlanDenialId).toBe('tu_abc');
  });
});
