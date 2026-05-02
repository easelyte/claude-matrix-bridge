import { writeFileSync, unlinkSync, readdirSync, statSync } from 'fs';

export function createLiveOutputStore({ ttlSeconds = 14400, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const entries = new Map();

  function register(toolUseId, { logPath, roomId }) {
    entries.set(toolUseId, {
      logPath,
      doneSentinelPath: `${logPath}.done`,
      roomId,
      expiresAt: now() + ttlSeconds,
      complete: false,
    });
  }

  function get(toolUseId) {
    return entries.get(toolUseId);
  }

  function markComplete(toolUseId, { exitCode = null, denied = false, truncated = false } = {}) {
    const entry = entries.get(toolUseId);
    if (!entry) return;
    writeFileSync(entry.doneSentinelPath, JSON.stringify({ exitCode, denied, truncated }));
    entry.complete = true;
  }

  function gcExpired() {
    let removed = 0;
    for (const [id, entry] of entries) {
      if (now() >= entry.expiresAt) {
        try { unlinkSync(entry.logPath); } catch {}
        try { unlinkSync(entry.doneSentinelPath); } catch {}
        entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  return { register, get, markComplete, gcExpired };
}

export function sweepOrphanedLogs(dir, ttlSeconds) {
  const cutoff = Date.now() - ttlSeconds * 1000;
  let removed = 0;
  let entries;
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const name of entries) {
    if (!name.startsWith('matron-cmd-')) continue;
    const full = `${dir}/${name}`;
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoff) {
        unlinkSync(full);
        removed++;
      }
    } catch {}
  }
  return removed;
}
