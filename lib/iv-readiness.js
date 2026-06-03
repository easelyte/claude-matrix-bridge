/**
 * IvReadinessController — side-effect-free readiness state machine for iv-mode sessions.
 *
 * Phases:
 *   'loading' — TUI is initialising; input is stashed in pendingInput FIFO.
 *   'modal'   — A TUI prompt is on screen; do NOT flush into it.
 *   'free'    — TUI is at the command-entry toolbar; deliver stashed + held input.
 *
 * All I/O is injected:
 *   deliver(blocks)          — called with content-block arrays to forward to the PTY.
 *   respond(response)        — called with {kind, key} to answer a modal prompt.
 *   notify(text)             — send a Matrix notice.
 *   setTimer(ms, fn)         — schedule a one-shot timer; returns an opaque handle.
 *   clearTimer(handle)       — cancel a handle returned by setTimer.
 *   clock()                  — returns current timestamp (ms); defaults to Date.now.
 *
 * The controller is created once per iv-session and disposed via dispose() when the
 * session is killed.
 */
export function IvReadinessController({
  deliver,
  respond,
  notify,
  setTimer,
  clearTimer,
  clock = Date.now,
} = {}) {
  // ── State ──────────────────────────────────────────────────────────────────
  let phase = 'loading';

  // FIFO queue of content-block arrays stashed before the TUI is ready.
  const pendingInput = [];

  // Input held during a modal (not to be auto-typed into the prompt).
  let heldInput = [];

  // /effort scan buffer — owned here so we can reset it on phase transitions.
  let _ptyBuf = '';

  // Timestamp after which an /effort cue counts as "fresh" (set on modal entry
  // and each prompt resolution so stale buffered cues don't trigger delivery).
  let cueFreshFrom = 0;

  // Timer handles (both owned by the controller so dispose() can cancel both).
  let _readyTimer = null;   // 30s loading→free fallback
  let _watchdogTimer = null; // 60s held-input safety net

  // ── Internal helpers ────────────────────────────────────────────────────────
  function armWatchdog() {
    if (_watchdogTimer !== null) clearTimer(_watchdogTimer);
    _watchdogTimer = setTimer(60_000, () => {
      _watchdogTimer = null;
      if (heldInput.length === 0) return;
      // Surface held text verbatim so the operator can resend if needed.
      const texts = heldInput.map(blocks =>
        blocks.filter(b => b.type === 'text').map(b => b.text).join('\n\n')
      ).filter(Boolean);
      const verbatim = texts.join('\n\n');
      notify(`Held since the menu, not yet delivered — resend if still needed: ${verbatim}`);
      heldInput = [];
    });
  }

  function clearWatchdog() {
    if (_watchdogTimer !== null) {
      clearTimer(_watchdogTimer);
      _watchdogTimer = null;
    }
  }

  function flushPendingInput() {
    const items = pendingInput.splice(0);
    for (const blocks of items) {
      deliver(blocks);
    }
  }

  function drainQueueToHeld() {
    // Move every item in pendingInput to heldInput in order.
    const items = pendingInput.splice(0);
    heldInput.push(...items);
  }

  // Called when a fresh /effort cue is confirmed (freshness + promptResolved already
  // checked by onPtyData). Transitions to free and delivers held input.
  function onFreeInputCue() {
    if (phase === 'loading') {
      setPhase('free', { flushQueue: true });
      return;
    }
    if (phase === 'modal') {
      setPhase('free', { flushQueue: false });
      // Deliver held input on this modal→free edge.
      if (heldInput.length > 0) {
        clearWatchdog();
        const toDeliver = heldInput.splice(0);
        for (const blocks of toDeliver) {
          deliver(blocks);
        }
      }
      return;
    }
    // phase === 'free' — no-op.
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Current phase: 'loading' | 'modal' | 'free'.
   */
  function getPhase() { return phase; }

  /**
   * Transition to a new phase.
   * flushQueue: true → flush pendingInput FIFO (only appropriate for loading→free).
   * The FIFO is NEVER flushed on entry to 'modal'.
   *
   * On transition TO 'modal' or on each prompt resolution: reset the /effort buffer
   * and set cueFreshFrom so stale cues don't trigger delivery.
   */
  function setPhase(next, { flushQueue = false } = {}) {
    phase = next;
    if (next === 'free' && flushQueue) {
      flushPendingInput();
    }
    if (next === 'modal') {
      // Reset the scan buffer and freshness so only new PTY data counts.
      _ptyBuf = '';
      cueFreshFrom = clock() + 1; // require data received strictly after now
    }
  }

  /**
   * Called by the pty-data handler with each raw PTY chunk.
   * Owns the /effort scan buffer and freshness gate.
   * When a fresh /effort cue is detected, fires onFreeInputCue().
   *
   * The caller is responsible for checking pendingInteractivePrompt == null
   * before the modal→free held-delivery fires; it does so by injecting a
   * `isPromptResolved` option or by calling setPhase('free') externally on
   * prompt resolution before calling onPtyData. In the simpler wiring used
   * here, the pty-data handler (in index.js) also calls ctrl.onPromptResolved()
   * which resets the buffer, and the modal→free edge fires from the NEXT chunk.
   *
   * @param {string} chunk
   * @param {number} now   — current timestamp (from clock())
   * @param {boolean} promptResolved — true if no pendingInteractivePrompt in caller
   */
  function onPtyData(chunk, now, promptResolved) {
    _ptyBuf += chunk;
    if (_ptyBuf.length > 4096) _ptyBuf = _ptyBuf.slice(-2048);
    if (_ptyBuf.includes('/effort')) {
      _ptyBuf = '';
      // Is this cue fresh (received after the last phase reset)?
      if (now >= cueFreshFrom) {
        if (phase === 'loading') {
          onFreeInputCue();
        } else if (phase === 'modal' && promptResolved) {
          onFreeInputCue();
        }
        // phase === 'free' — no-op (toolbar already visible)
      }
    }
  }

  /**
   * Called when a TUI prompt fires (iv.on('prompt')).
   * Transitions to 'modal', resets freshness, and drains the FIFO:
   *   - First item in pendingInput: run through matcher.
   *     - matchResult is non-null → respond(matchResult) + Matrix confirmation
   *       is the caller's job (controller calls respond() and returns the result
   *       so caller can send confirmation).
   *     - null (prose/no match) → move to heldInput.
   *   - All remaining items → heldInput.
   * Arms the watchdog if heldInput ends up non-empty.
   *
   * Returns { resolved, matchResult } so the caller can send the Matrix confirmation.
   * matchResult is the {kind,key} object or null.
   */
  function onPrompt(matcher) {
    setPhase('modal');
    cueFreshFrom = clock() + 1;

    let resolved = false;
    let matchResult = null;

    if (pendingInput.length > 0) {
      const first = pendingInput[0];
      const firstText = first.filter(b => b.type === 'text').map(b => b.text).join('\n\n').trim();
      matchResult = matcher ? matcher(firstText) : null;

      if (matchResult && !matchResult.freeText) {
        // Bare token matched — consume first item from queue and respond.
        pendingInput.shift();
        respond(matchResult);
        resolved = true;
      } else if (matchResult && matchResult.freeText) {
        // Free-text slot matched — consume first item and surface it to the
        // caller so it can navigate to the free-text option and paste the text.
        // Do NOT leave it in the queue to drain into heldInput (B1 fix).
        pendingInput.shift();
        matchResult = { freeText: true, stashedText: firstText };
        resolved = true;
      }
      // Move all remaining items to heldInput.
      drainQueueToHeld();
    }

    if (heldInput.length > 0) {
      armWatchdog();
    }

    return { resolved, matchResult };
  }

  /**
   * Called after a prompt is resolved (by the live reply path or by onPrompt).
   * Resets the /effort buffer and cueFreshFrom so subsequent PTY data is treated
   * as a fresh signal.
   */
  function onPromptResolved() {
    _ptyBuf = '';
    cueFreshFrom = clock() + 1;
  }

  /**
   * Append a content-block array to the stash / held / type depending on phase.
   * - loading  → FIFO append (stash).
   * - modal    → append to heldInput, arm watchdog.
   * - free     → deliver immediately.
   * matcher is a (text) => {kind,key}|{freeText}|null function for modal phase.
   * Returns { action: 'stashed'|'held'|'delivered' }.
   */
  function accept(blocks, { matcher: _matcher } = {}) {
    if (phase === 'loading') {
      pendingInput.push(blocks);
      return { action: 'stashed' };
    }
    if (phase === 'modal') {
      heldInput.push(blocks);
      if (heldInput.length === 1) armWatchdog(); // first item: arm
      return { action: 'held' };
    }
    // free
    deliver(blocks);
    return { action: 'delivered' };
  }

  /**
   * Cancel both timers. Called from killSession.
   */
  function dispose() {
    if (_readyTimer !== null) { clearTimer(_readyTimer); _readyTimer = null; }
    clearWatchdog();
  }

  /**
   * Arm the 30s readiness timer. The callback checks phase and only transitions
   * loading→free; if already modal or free it's a no-op (never flushes into modal).
   */
  function armReadyTimer() {
    if (_readyTimer !== null) return; // idempotent
    _readyTimer = setTimer(30_000, () => {
      _readyTimer = null;
      if (phase === 'loading') {
        setPhase('free', { flushQueue: true });
      }
      // modal or free: do nothing — never flush into a modal.
    });
  }

  return {
    // Phase access
    getPhase,
    setPhase,
    // Event handlers
    onPtyData,
    onPrompt,
    onPromptResolved,
    // Input routing
    accept,
    // Timer management
    armReadyTimer,
    dispose,
    // Expose for testing
    get phase() { return phase; },
    get pendingInput() { return pendingInput; },
    get heldInput() { return heldInput; },
    get cueFreshFrom() { return cueFreshFrom; },
  };
}

/**
 * Pure helper: match an operator text reply against a detected TUI prompt.
 *
 * Returns:
 *   {kind, key}      — exact token match → respond with this
 *   {freeText: true} — prompt has a free-text slot and text didn't match a token
 *   null             — no match; text is free prose (do NOT auto-resolve)
 *
 * Intentionally uses ANCHORED EXACT tokens — no parseInt prefix matching.
 * "2 do X" does NOT match a numbered prompt (returns null, held as prose).
 */
export function matchPromptResponse(prompt, text) {
  if (!prompt || !text) return null;
  const trimmed = text.trim().toLowerCase();

  if (prompt.kind === 'yes-no') {
    if (/^(y|yes)$/.test(trimmed)) return { kind: 'yes-no', key: 'y' };
    if (/^(n|no)$/.test(trimmed)) return { kind: 'yes-no', key: 'n' };
    if (/^1$/.test(trimmed)) return { kind: 'yes-no', key: 'y' };
    if (/^2$/.test(trimmed)) return { kind: 'yes-no', key: 'n' };
    return null;
  }

  // Numbered prompt
  if (prompt.kind === 'numbered' || prompt.kind === 'arrow-menu') {
    if (/^\d{1,2}$/.test(trimmed)) {
      const n = Number(trimmed);
      if (n >= 1 && n <= prompt.options.length) {
        const opt = prompt.options[n - 1];
        if (prompt.kind === 'arrow-menu') {
          return { kind: 'arrow-menu', key: String(n - 1) };
        }
        return { kind: prompt.kind, key: opt.key };
      }
    }
    // Single lowercase letter on a lettered/numbered prompt
    if (prompt.kind === 'lettered' && /^[a-z]$/.test(trimmed)) {
      return { kind: 'lettered', key: trimmed };
    }
    // Free-text slot? Bound-check idx to avoid out-of-range dereference (M1 fix).
    if (typeof prompt.freeTextIdx === 'number' && prompt.freeTextIdx >= 0 &&
        prompt.freeTextIdx < prompt.options.length) {
      return { freeText: true };
    }
    return null;
  }

  // Lettered prompt
  if (prompt.kind === 'lettered') {
    if (/^[a-z]$/.test(trimmed)) return { kind: 'lettered', key: trimmed };
    if (/^\d{1,2}$/.test(trimmed)) {
      const n = Number(trimmed);
      if (n >= 1 && n <= prompt.options.length) {
        return { kind: 'lettered', key: prompt.options[n - 1]?.key || trimmed };
      }
    }
    // Free-text slot? Bound-check idx to avoid out-of-range dereference (M1 fix).
    if (typeof prompt.freeTextIdx === 'number' && prompt.freeTextIdx >= 0 &&
        prompt.freeTextIdx < prompt.options.length) {
      return { freeText: true };
    }
    return null;
  }

  return null;
}
