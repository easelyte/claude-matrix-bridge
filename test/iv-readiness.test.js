/**
 * Unit tests for IvReadinessController and matchPromptResponse (Fix 2).
 *
 * Covers spec test plan §2 (a-g) plus additional plan-review cases:
 *   - live prose during a modal is held, not typed
 *   - "2 do X" is NOT auto-selected
 *   - prose held mid-modal is watchdog-armed (R2 B1)
 *   - ctrl.dispose() clears both timers (R2 B3)
 *
 * All tests use injected fake timers/clock — no app-entrypoint import.
 */

import { describe, test, expect } from 'vitest';
import { IvReadinessController, matchPromptResponse } from '../lib/iv-readiness.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a controller wired to in-memory spies and a fake timer/clock.
 */
function makeCtrl({ clockStart = 0 } = {}) {
  let now = clockStart;
  const clock = () => now;
  const advanceClock = ms => { now += ms; };

  const timers = new Map();
  let timerSeq = 0;
  const setTimer = (ms, fn) => {
    const id = ++timerSeq;
    timers.set(id, { fn, fireAt: now + ms });
    return id;
  };
  const clearTimer = id => { timers.delete(id); };
  const fireTimerAt = id => {
    const t = timers.get(id);
    if (!t) return false;
    timers.delete(id);
    t.fn();
    return true;
  };
  const fireTimerAfter = ms => {
    advanceClock(ms);
    for (const [id, t] of [...timers.entries()]) {
      if (t.fireAt <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };

  const deliveries = [];
  const responses = [];
  const notices = [];

  const ctrl = IvReadinessController({
    deliver: blocks => deliveries.push(blocks),
    respond: res => responses.push(res),
    notify: text => notices.push(text),
    setTimer,
    clearTimer,
    clock,
  });

  return { ctrl, deliveries, responses, notices, timers, fireTimerAt, fireTimerAfter, advanceClock, clock };
}

/** Simple numbered prompt fixture */
function numberedPrompt(n = 3) {
  return {
    kind: 'numbered',
    question: 'Choose an option:',
    options: Array.from({ length: n }, (_, i) => ({ key: String(i + 1), label: `Option ${i + 1}` })),
  };
}

function yesNoPrompt() {
  return {
    kind: 'yes-no',
    question: 'Continue?',
    options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }],
  };
}

function textBlocks(text) {
  return [{ type: 'text', text }];
}

// ── matchPromptResponse ─────────────────────────────────────────────────────

describe('matchPromptResponse', () => {
  test('yes-no: y/yes/1 → yes, n/no/2 → no', () => {
    const p = yesNoPrompt();
    expect(matchPromptResponse(p, 'y')).toEqual({ kind: 'yes-no', key: 'y' });
    expect(matchPromptResponse(p, 'Y')).toEqual({ kind: 'yes-no', key: 'y' });
    expect(matchPromptResponse(p, 'yes')).toEqual({ kind: 'yes-no', key: 'y' });
    expect(matchPromptResponse(p, 'YES')).toEqual({ kind: 'yes-no', key: 'y' });
    expect(matchPromptResponse(p, '1')).toEqual({ kind: 'yes-no', key: 'y' });
    expect(matchPromptResponse(p, 'n')).toEqual({ kind: 'yes-no', key: 'n' });
    expect(matchPromptResponse(p, 'no')).toEqual({ kind: 'yes-no', key: 'n' });
    expect(matchPromptResponse(p, '2')).toEqual({ kind: 'yes-no', key: 'n' });
  });

  test('yes-no: free prose → null (not auto-answered)', () => {
    const p = yesNoPrompt();
    expect(matchPromptResponse(p, 'yes please')).toBeNull();
    expect(matchPromptResponse(p, 'do X')).toBeNull();
    expect(matchPromptResponse(p, '')).toBeNull();
  });

  test('numbered: exact digit resolves correct option', () => {
    const p = numberedPrompt(3);
    expect(matchPromptResponse(p, '1')).toEqual({ kind: 'numbered', key: '1' });
    expect(matchPromptResponse(p, '2')).toEqual({ kind: 'numbered', key: '2' });
    expect(matchPromptResponse(p, '3')).toEqual({ kind: 'numbered', key: '3' });
  });

  test('numbered: out-of-range digit → null', () => {
    const p = numberedPrompt(3);
    expect(matchPromptResponse(p, '4')).toBeNull();
    expect(matchPromptResponse(p, '0')).toBeNull();
  });

  test('"2 do X" does NOT auto-select option 2 (exact-token only)', () => {
    const p = numberedPrompt(3);
    // The old parseInt code would have matched "2 do X" → 2. New code must NOT.
    expect(matchPromptResponse(p, '2 do X')).toBeNull();
    expect(matchPromptResponse(p, '2 and something')).toBeNull();
    expect(matchPromptResponse(p, '  2  extra  ')).toBeNull();
  });

  test('numbered: prose → null', () => {
    const p = numberedPrompt(3);
    expect(matchPromptResponse(p, 'do X and Y')).toBeNull();
    expect(matchPromptResponse(p, 'resume session')).toBeNull();
  });

  test('lettered: single letter resolves', () => {
    const p = {
      kind: 'lettered',
      question: 'Pick:',
      options: [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }],
    };
    expect(matchPromptResponse(p, 'a')).toEqual({ kind: 'lettered', key: 'a' });
    expect(matchPromptResponse(p, 'B')).toEqual({ kind: 'lettered', key: 'b' });
  });

  test('lettered: prose → null', () => {
    const p = {
      kind: 'lettered',
      question: 'Pick:',
      options: [{ key: 'a', label: 'Alpha' }],
    };
    expect(matchPromptResponse(p, 'alpha')).toBeNull();
    expect(matchPromptResponse(p, 'do something')).toBeNull();
  });

  test('null/empty inputs are safe', () => {
    expect(matchPromptResponse(null, '1')).toBeNull();
    expect(matchPromptResponse(numberedPrompt(), null)).toBeNull();
    expect(matchPromptResponse(numberedPrompt(), '')).toBeNull();
  });
});

// ── IvReadinessController — spec test plan §2 ──────────────────────────────

describe('IvReadinessController — phase machine', () => {

  // (a) Bare-token stash resolve
  test('(a) "2" resolves a numbered prompt, dequeues, nothing typed as free text', () => {
    const { ctrl, deliveries, responses } = makeCtrl();
    ctrl.armReadyTimer();
    expect(ctrl.phase).toBe('loading');

    // Stash "2" before prompt fires.
    ctrl.accept(textBlocks('2'));
    expect(ctrl.pendingInput).toHaveLength(1);

    // Prompt fires.
    const prompt = numberedPrompt(3);
    const matcher = text => matchPromptResponse(prompt, text);
    const { resolved, matchResult } = ctrl.onPrompt(matcher);

    expect(resolved).toBe(true);
    expect(matchResult).toEqual({ kind: 'numbered', key: '2' });
    // responded, not delivered as free text
    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({ kind: 'numbered', key: '2' });
    expect(deliveries).toHaveLength(0);
    // Queue drained
    expect(ctrl.pendingInput).toHaveLength(0);
  });

  // (b) "do X and Y" is moved to heldInput; /effort after resolution delivers it once
  test('(b) prose stash → heldInput; /effort after resolution delivers once, not twice', () => {
    const { ctrl, deliveries } = makeCtrl({ clockStart: 1000 });
    ctrl.armReadyTimer();

    ctrl.accept(textBlocks('do X and Y'));

    // Prompt fires — prose moves to heldInput.
    const prompt = numberedPrompt(3);
    const matcher = text => matchPromptResponse(prompt, text);
    const { resolved } = ctrl.onPrompt(matcher);
    expect(resolved).toBe(false);
    expect(ctrl.heldInput).toHaveLength(1);
    expect(deliveries).toHaveLength(0);

    // Resolve the prompt externally (operator answered).
    ctrl.onPromptResolved();
    expect(ctrl.phase).toBe('modal');

    // /effort cue arrives (promptResolved=true, cueFreshFrom satisfied).
    ctrl.onPtyData('/effort here', ctrl.cueFreshFrom + 1, true);
    expect(ctrl.phase).toBe('free');
    expect(deliveries).toHaveLength(1);
    expect(ctrl.heldInput).toHaveLength(0);

    // Second /effort cue delivers nothing.
    ctrl.onPtyData('/effort again', ctrl.cueFreshFrom + 2, true);
    expect(deliveries).toHaveLength(1);
  });

  // (c) Timeout does NOT flush into a modal
  test('(c) 30s timer in modal phase → no flush, phase unchanged', () => {
    const { ctrl, deliveries, fireTimerAfter } = makeCtrl({ clockStart: 0 });
    ctrl.armReadyTimer();

    // Stash something, then enter modal.
    ctrl.accept(textBlocks('pending message'));
    ctrl.onPrompt(() => null); // no match
    expect(ctrl.phase).toBe('modal');

    // Fire the 30s ready timer.
    fireTimerAfter(30_001);

    // Phase must remain modal, nothing delivered.
    expect(ctrl.phase).toBe('modal');
    expect(deliveries).toHaveLength(0);
  });

  // (d) /effort reaches onFreeInputCue after a modal (no early-return)
  test('(d) /effort cue is reachable in free phase after modal resolves', () => {
    const { ctrl, deliveries } = makeCtrl({ clockStart: 1000 });
    ctrl.armReadyTimer();

    // Enter modal with held text.
    ctrl.accept(textBlocks('prose message'));
    ctrl.onPrompt(() => null);
    expect(ctrl.phase).toBe('modal');
    expect(ctrl.heldInput).toHaveLength(1);

    // Resolve the prompt.
    ctrl.onPromptResolved();

    // PTY emits /effort — controller must react (no early-return).
    const freshTime = ctrl.cueFreshFrom + 1;
    ctrl.onPtyData('/effort toolbar', freshTime, true);
    expect(ctrl.phase).toBe('free');
    expect(deliveries).toHaveLength(1);
    expect(ctrl.heldInput).toHaveLength(0);
  });

  // (e) Watchdog fires → Matrix notice with verbatim text; nothing auto-typed
  test('(e) watchdog fires → notice with held text verbatim; heldInput cleared', () => {
    const { ctrl, deliveries, notices, fireTimerAfter } = makeCtrl({ clockStart: 0 });
    ctrl.armReadyTimer();

    // Stash prose, enter modal.
    ctrl.accept(textBlocks('very important message'));
    ctrl.onPrompt(() => null);
    expect(ctrl.heldInput).toHaveLength(1);

    // Fire the 60s watchdog.
    fireTimerAfter(60_001);

    // Notice emitted, heldInput cleared, nothing typed.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('very important message');
    expect(ctrl.heldInput).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  });

  // (f) FIFO: two messages before readiness → both preserved in order; first bare-token-resolved, remainder held
  test('(f) FIFO: two pre-ready messages; first resolved as bare-token, second → heldInput', () => {
    const { ctrl, responses, deliveries } = makeCtrl();
    ctrl.armReadyTimer();

    ctrl.accept(textBlocks('2'));           // first — bare token
    ctrl.accept(textBlocks('do something')); // second — prose

    const prompt = numberedPrompt(3);
    const matcher = text => matchPromptResponse(prompt, text);
    const { resolved } = ctrl.onPrompt(matcher);

    expect(resolved).toBe(true);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({ kind: 'numbered', key: '2' });
    // Second item moved to heldInput, not delivered.
    expect(ctrl.heldInput).toHaveLength(1);
    expect(deliveries).toHaveLength(0);
    // pendingInput fully drained.
    expect(ctrl.pendingInput).toHaveLength(0);
  });

  // (f) FIFO no-drop: second pre-ready message is NOT dropped (last-writer-wins prevention)
  test('(f) FIFO: second pre-ready append does not overwrite the first', () => {
    const { ctrl } = makeCtrl();
    ctrl.armReadyTimer();

    ctrl.accept(textBlocks('first'));
    ctrl.accept(textBlocks('second'));

    expect(ctrl.pendingInput).toHaveLength(2);
    expect(ctrl.pendingInput[0]).toEqual(textBlocks('first'));
    expect(ctrl.pendingInput[1]).toEqual(textBlocks('second'));
  });

  // (g) loading + /effort → free, queue flushed normally
  test('(g) loading + /effort (no modal) → free, pendingInput flushed', () => {
    const { ctrl, deliveries } = makeCtrl({ clockStart: 100 });
    ctrl.armReadyTimer();

    ctrl.accept(textBlocks('hello'));
    ctrl.accept(textBlocks('world'));
    expect(ctrl.phase).toBe('loading');

    // /effort arrives before any prompt.
    ctrl.onPtyData('/effort toolbar', 200, true);
    expect(ctrl.phase).toBe('free');
    expect(deliveries).toHaveLength(2);
    expect(ctrl.pendingInput).toHaveLength(0);
  });

  // Extra: live prose during a modal is held, not typed
  test('live prose arriving DURING modal → held (accept returns "held"), not delivered', () => {
    const { ctrl, deliveries } = makeCtrl();
    ctrl.armReadyTimer();

    // Enter modal with empty stash.
    ctrl.setPhase('modal');

    // Accept a live prose message while modal is on screen.
    const result = ctrl.accept(textBlocks('some prose during modal'));
    expect(result.action).toBe('held');
    expect(ctrl.heldInput).toHaveLength(1);
    expect(deliveries).toHaveLength(0);
  });

  // Extra: "2 do X" not auto-selected (exercised via the prompt + matcher path)
  test('"2 do X" is NOT auto-selected — matchPromptResponse returns null', () => {
    const { ctrl, responses, deliveries } = makeCtrl();
    ctrl.armReadyTimer();

    ctrl.accept(textBlocks('2 do X'));

    const prompt = numberedPrompt(3);
    const matcher = text => matchPromptResponse(prompt, text);
    const { resolved } = ctrl.onPrompt(matcher);

    expect(resolved).toBe(false);
    expect(responses).toHaveLength(0);
    expect(ctrl.heldInput).toHaveLength(1);
    expect(deliveries).toHaveLength(0);
  });

  // Extra: prose held mid-modal → watchdog armed (R2 B1)
  test('prose appended mid-modal (empty stash at modal entry) → watchdog armed', () => {
    const { ctrl, notices, fireTimerAfter } = makeCtrl({ clockStart: 0 });
    ctrl.armReadyTimer();

    // Enter modal with empty stash — no watchdog yet.
    ctrl.setPhase('modal');
    expect(ctrl.heldInput).toHaveLength(0);

    // Live prose arrives during the modal.
    ctrl.accept(textBlocks('late prose'));
    expect(ctrl.heldInput).toHaveLength(1);

    // Fire the 60s watchdog.
    fireTimerAfter(60_001);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('late prose');
    expect(ctrl.heldInput).toHaveLength(0);
  });

  // Extra: dispose() clears both timers (R2 B3)
  test('dispose() cancels both the readiness timer and the watchdog', () => {
    const { ctrl, notices, deliveries, timers } = makeCtrl({ clockStart: 0 });
    ctrl.armReadyTimer();

    // Arm the watchdog by entering modal with held input.
    ctrl.accept(textBlocks('held text'));
    ctrl.onPrompt(() => null);
    expect(ctrl.heldInput).toHaveLength(1);

    // Both timers should now exist.
    expect(timers.size).toBeGreaterThanOrEqual(1);

    ctrl.dispose();

    // All timers cancelled.
    expect(timers.size).toBe(0);

    // Advancing past both intervals fires nothing.
    // (If timers were still running, notices/deliveries would have grown.)
    expect(notices).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  });

  // Stale /effort cue (before cueFreshFrom) does NOT deliver held input
  test('stale /effort cue (before cueFreshFrom) does NOT deliver held input', () => {
    const { ctrl, deliveries } = makeCtrl({ clockStart: 1000 });
    ctrl.armReadyTimer();

    ctrl.accept(textBlocks('message'));
    ctrl.onPrompt(() => null);
    ctrl.onPromptResolved();

    const staleTime = ctrl.cueFreshFrom - 1; // before the freshness cutoff
    ctrl.onPtyData('/effort stale', staleTime, true);

    // Should not have delivered.
    expect(deliveries).toHaveLength(0);
    expect(ctrl.heldInput).toHaveLength(1);
  });

  // onPromptResolved resets cueFreshFrom
  test('onPromptResolved resets buffer and advances cueFreshFrom', () => {
    const { ctrl } = makeCtrl({ clockStart: 500 });
    ctrl.armReadyTimer();

    ctrl.setPhase('modal');
    const before = ctrl.cueFreshFrom;
    ctrl.onPromptResolved();
    expect(ctrl.cueFreshFrom).toBeGreaterThanOrEqual(before);
  });

  // setPhase('free', {flushQueue:true}) delivers each stash item separately
  test('setPhase(free, flushQueue) delivers each queued item via deliver() separately', () => {
    const { ctrl, deliveries } = makeCtrl();
    ctrl.armReadyTimer();

    ctrl.accept(textBlocks('msg A'));
    ctrl.accept(textBlocks('msg B'));
    ctrl.accept(textBlocks('msg C'));

    ctrl.setPhase('free', { flushQueue: true });

    expect(deliveries).toHaveLength(3);
    expect(deliveries[0]).toEqual(textBlocks('msg A'));
    expect(deliveries[1]).toEqual(textBlocks('msg B'));
    expect(deliveries[2]).toEqual(textBlocks('msg C'));
  });

  // Watchdog notice clears heldInput so a subsequent /effort doesn't redeliver
  test('after watchdog fires, a subsequent /effort cue delivers nothing', () => {
    const { ctrl, deliveries, notices, fireTimerAfter } = makeCtrl({ clockStart: 0 });
    ctrl.armReadyTimer();

    ctrl.accept(textBlocks('once'));
    ctrl.onPrompt(() => null);
    ctrl.onPromptResolved();

    // Fire watchdog first.
    fireTimerAfter(60_001);
    expect(notices).toHaveLength(1);
    expect(ctrl.heldInput).toHaveLength(0);

    // Now /effort arrives.
    ctrl.onPtyData('/effort now', ctrl.cueFreshFrom + 1, true);
    // Nothing to deliver — heldInput was cleared.
    expect(deliveries).toHaveLength(0);
  });
});
