// Helpers for injecting input into a claude PTY.
//
// Phase 0.4 finding (2026-05-14): the trailing Enter that submits a pasted
// message MUST be sent as a separate write after a short delay. If `\r` is
// concatenated immediately after the bracketed-paste close sequence the TUI
// silently drops it, because the TUI buffers paste content and uses extended
// keyboard protocols (modifyOtherKeys, kitty) that re-encode keystrokes mid-
// way through paste handling.
//
// Callers should do:
//
//   pty.write(bracketedPaste(text));
//   setTimeout(() => pty.write(keystroke('enter')), SUBMIT_DELAY_MS);

export const SUBMIT_DELAY_MS = 500;

export function bracketedPaste(text) {
  return `\x1b[200~${text}\x1b[201~`;
}

const KEYS = {
  enter: '\r',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  esc: '\x1b',
  tab: '\t',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  backspace: '\x7f',
};

export function keystroke(name) {
  if (KEYS[name] !== undefined) return KEYS[name];
  if (typeof name === 'string' && /^[\x20-\x7e]$/.test(name)) return name;
  throw new Error(`unknown key: ${JSON.stringify(name)}`);
}
