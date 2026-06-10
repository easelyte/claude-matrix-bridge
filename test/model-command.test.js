import { describe, it, expect } from 'vitest';
import { switchModelInSession, modelButtons } from '../lib/model-command.js';

function fakeSession({ iv = null, currentModel = null } = {}) {
  const sent = [];
  const typed = [];
  return {
    currentModel,
    iv: iv === 'live' ? { alive: true, sendText: (t) => typed.push(t) } : iv,
    _sent: sent,
    _typed: typed,
    send: (m) => sent.push(m),
  };
}

describe('switchModelInSession', () => {
  it('drives /model <alias> into the PTY and confirms on a valid alias', () => {
    const s = fakeSession({ iv: 'live' });
    const ok = switchModelInSession(s, 'sonnet', s.send);
    expect(ok).toBe(true);
    expect(s._typed).toEqual(['/model sonnet']);
    expect(s._sent.join(' ')).toMatch(/Sonnet/);
  });

  it('normalizes the alias before sending', () => {
    const s = fakeSession({ iv: 'live' });
    switchModelInSession(s, '  OPUS[1M] ', s.send);
    expect(s._typed).toEqual(['/model opus[1m]']);
  });

  it('rejects an unknown alias without touching the PTY', () => {
    const s = fakeSession({ iv: 'live' });
    const ok = switchModelInSession(s, 'banana', s.send);
    expect(ok).toBe(false);
    expect(s._typed).toEqual([]);
    expect(s._sent.join(' ')).toMatch(/Unknown model/);
  });

  it('degrades gracefully when there is no live TUI (print mode)', () => {
    const s = fakeSession({ iv: null, currentModel: 'claude-opus-4-8' });
    const ok = switchModelInSession(s, 'sonnet', s.send);
    expect(ok).toBe(false);
    expect(s._sent.join(' ')).toMatch(/interactive mode/);
    expect(s._sent.join(' ')).toMatch(/claude-opus-4-8/);
  });

  it('does not falsely confirm when the PTY write fails (dead session)', () => {
    const sent = [];
    const session = {
      currentModel: null,
      // A dead iv session: sendText returns false and writes nothing.
      iv: { alive: false, sendText: () => false },
    };
    const ok = switchModelInSession(session, 'sonnet', (m) => sent.push(m));
    expect(ok).toBe(false);
    expect(sent.join(' ')).not.toMatch(/Switching to/);
    expect(sent.join(' ')).toMatch(/isn't accepting input|couldn't|could not/i);
  });

  it('refuses (does not type) while the session is still resuming (input hold)', () => {
    const sent = [];
    const typed = [];
    const session = {
      currentModel: null,
      _awaitingInputReady: true, // auto-resume hold is active
      iv: { alive: true, sendText: (t) => { typed.push(t); return true; } },
    };
    const ok = switchModelInSession(session, 'sonnet', (m) => sent.push(m));
    expect(ok).toBe(false);
    expect(typed).toEqual([]); // never wrote to the PTY
    expect(sent.join(' ')).not.toMatch(/Switching to/);
    expect(sent.join(' ')).toMatch(/resuming/i);
  });
});

describe('modelButtons', () => {
  it('builds one namespaced button per switchable alias', () => {
    const buttons = modelButtons();
    expect(buttons).toHaveLength(8);
    expect(buttons[0]).toEqual({ id: 'model-default', label: 'Default', value: 'model:default' });
    expect(buttons.find(b => b.label === 'Opus 1M')).toEqual({
      id: 'model-opus[1m]', label: 'Opus 1M', value: 'model:opus[1m]',
    });
  });
});
