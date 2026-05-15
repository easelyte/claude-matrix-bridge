import { describe, it, expect } from 'vitest';
import { bracketedPaste, keystroke, SUBMIT_DELAY_MS } from '../lib/pty-input.js';

describe('bracketedPaste', () => {
  it('wraps text in bracketed-paste sequences without a trailing Enter', () => {
    expect(bracketedPaste('hello')).toBe('\x1b[200~hello\x1b[201~');
  });

  it('preserves newlines inside the paste', () => {
    expect(bracketedPaste('a\nb\nc')).toBe('\x1b[200~a\nb\nc\x1b[201~');
  });

  it('preserves an empty string (caller may still want to submit)', () => {
    expect(bracketedPaste('')).toBe('\x1b[200~\x1b[201~');
  });
});

describe('keystroke', () => {
  it('maps named control keys to bytes', () => {
    expect(keystroke('enter')).toBe('\r');
    expect(keystroke('up')).toBe('\x1b[A');
    expect(keystroke('down')).toBe('\x1b[B');
    expect(keystroke('right')).toBe('\x1b[C');
    expect(keystroke('left')).toBe('\x1b[D');
    expect(keystroke('esc')).toBe('\x1b');
    expect(keystroke('tab')).toBe('\t');
    expect(keystroke('ctrl-c')).toBe('\x03');
    expect(keystroke('ctrl-d')).toBe('\x04');
    expect(keystroke('backspace')).toBe('\x7f');
  });

  it('passes through single printable characters', () => {
    expect(keystroke('y')).toBe('y');
    expect(keystroke('1')).toBe('1');
    expect(keystroke('/')).toBe('/');
  });

  it('throws on an unknown key name', () => {
    expect(() => keystroke('foo')).toThrow(/unknown key/i);
  });
});

describe('SUBMIT_DELAY_MS', () => {
  it('is at least 300ms (empirically required by claude TUI after bracketed paste)', () => {
    // Phase 0.4 found that <300ms is unreliable; 500ms is the chosen default.
    expect(SUBMIT_DELAY_MS).toBeGreaterThanOrEqual(300);
  });
});
