import { describe, it, expect } from 'vitest';
import { classifyScreen, stripAnsi, PromptDetector } from '../lib/prompt-detector.js';

describe('stripAnsi', () => {
  it('removes color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });
  it('removes cursor movements and modes', () => {
    expect(stripAnsi('\x1b[2J\x1b[H\x1b[?25lhello\x1b[?25h')).toBe('hello');
  });
  it('removes bare CR that has no LF after it (TUI overwrites)', () => {
    expect(stripAnsi('foo\rbar\r\nbaz')).toBe('foobar\nbaz');
  });

  it('replaces CSI cursor-forward with the corresponding number of spaces', () => {
    // claude renders gaps between words as \x1b[1C rather than literal spaces.
    expect(stripAnsi('Yes,\x1b[1Cmanually\x1b[1Capprove\x1b[1Cedits'))
      .toBe('Yes, manually approve edits');
    expect(stripAnsi('\x1b[3CIndented'))
      .toBe('   Indented');
    // \x1b[C with no digits = 1
    expect(stripAnsi('a\x1b[Cb')).toBe('a b');
  });
});

describe('classifyScreen — yes/no', () => {
  it('detects [y/N]', () => {
    const r = classifyScreen('Continue with this plan? [y/N]');
    expect(r.kind).toBe('yes-no');
    expect(r.options).toEqual([
      { key: 'y', label: 'Yes' },
      { key: 'n', label: 'No' },
    ]);
  });

  it('detects (y/N) with parens', () => {
    const r = classifyScreen('Apply this change? (y/N)');
    expect(r.kind).toBe('yes-no');
  });

  it('detects [Y/n] with capital Y default', () => {
    const r = classifyScreen('Save and exit? [Y/n]');
    expect(r.kind).toBe('yes-no');
  });
});

describe('classifyScreen — numbered', () => {
  it('detects a multi-line numbered list with a trailing prompt', () => {
    const screen = [
      'Choose a model:',
      '  1) Sonnet',
      '  2) Opus',
      '  3) Haiku',
      '> ',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r.kind).toBe('numbered');
    expect(r.options).toHaveLength(3);
    expect(r.options[0]).toEqual({ key: '1', label: 'Sonnet' });
    expect(r.options[2]).toEqual({ key: '3', label: 'Haiku' });
    expect(r.question).toContain('Choose a model');
  });

  it('detects 1. 2. dot-style numbering', () => {
    const screen = [
      'Pick one:',
      '1. Foo',
      '2. Bar',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r.kind).toBe('numbered');
    expect(r.options.map(o => o.label)).toEqual(['Foo', 'Bar']);
  });

  it('returns null for a single numbered line (not enough to be a menu)', () => {
    const screen = 'Found 1) thing in the codebase';
    expect(classifyScreen(screen)).toBeNull();
  });
});

describe('classifyScreen — lettered', () => {
  it('detects (a) (b) (c) options', () => {
    const screen = [
      'Action:',
      '(a) Approve',
      '(b) Deny',
      '(c) Defer',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r.kind).toBe('lettered');
    expect(r.options.map(o => o.key)).toEqual(['a', 'b', 'c']);
  });
});

describe('classifyScreen — arrow-menu', () => {
  it('detects ❯ selection marker', () => {
    const screen = [
      'Pick one:',
      '❯ Option A',
      '  Option B',
      '  Option C',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r.kind).toBe('arrow-menu');
    expect(r.options).toHaveLength(3);
    expect(r.options[0].selected).toBe(true);
    expect(r.options[1].selected).toBe(false);
    expect(r.options.map(o => o.label)).toEqual(['Option A', 'Option B', 'Option C']);
  });

  it('detects > selection marker', () => {
    const screen = [
      'Pick:',
      '> First',
      '  Second',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r.kind).toBe('arrow-menu');
  });
});

describe('classifyScreen — numbered list inside prose', () => {
  it('returns null on a numbered list with a non-question header (no menu context)', () => {
    // Real bug: claude's plan content contained a "Verification" section
    // with numbered steps. The detector misread those steps as menu options.
    const screen = [
      'Verification',
      '',
      '1. cd ~/claude-matrix-bridge && git pull',
      '2. sudo systemctl restart claude-matrix-bridge.service',
      '3. In Matrix, send !version',
    ].join('\n');
    expect(classifyScreen(screen)).toBeNull();
  });

  it('still detects numbered when header ends with a colon (instructive)', () => {
    const screen = [
      'Choose a model:',
      '1. Sonnet',
      '2. Opus',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('numbered');
  });

  it('still detects numbered when first item has a selection marker', () => {
    const screen = [
      'Verification',
      '',
      '❯ 1. Run tests',
      '  2. Skip tests',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('numbered');
  });
});

describe('classifyScreen — multiple numbered runs', () => {
  it('picks the run that passes the menu guard, not the longest run', () => {
    // Real screen from iv-mode testing: a "Verification" numbered list
    // inside plan prose (5 items, no question header) followed by the
    // bypass-permissions confirmation menu (4 items, question above,
    // ❯ marker on first item). Old code took the longest run (verification),
    // failed its guard, and fell through to a bad arrow-menu match.
    const screen = [
      'Verification',
      '1. cd ~/claude-matrix-bridge && git pull',
      '2. sudo systemctl restart',
      '3. send !version',
      '4. try /version',
      '5. confirm !help',
      '',
      '────────────────────────',
      'Claude has written up a plan and is ready to execute. Would you like to proceed?',
      '❯ 1. Yes, and bypass permissions',
      '  2. Yes, manually approve edits',
      '  3. No, refine with Ultraplan',
      '  4. Tell Claude what to change',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('numbered');
    expect(r.options).toHaveLength(4);
    expect(r.options[0].label).toMatch(/Yes, and bypass permissions/);
  });
});

describe('classifyScreen — keyboard hint filtering', () => {
  it('does not include keyboard hint lines as menu options', () => {
    const screen = [
      'Would you like to proceed?',
      '❯ Yes',
      '  No',
      '  shift+tab to approve with this feedback',
      '  ctrl-g to edit in VS Code',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.options.map(o => o.label)).toEqual(['Yes', 'No']);
  });
});

describe('classifyScreen — null cases', () => {
  it('returns null on plain assistant output', () => {
    expect(classifyScreen('Working on it…\nDone.\n> ')).toBeNull();
  });

  it('returns null on an empty screen', () => {
    expect(classifyScreen('')).toBeNull();
  });

  it('returns null when only the input box is visible', () => {
    expect(classifyScreen('\n\n> ')).toBeNull();
  });

  it('returns null on claude TUI welcome screen (the false-positive that broke iv-mode cutover)', () => {
    // Real reproduction: ❯ marks the input placeholder, followed by a
    // box-drawing separator and a status line with ⏵⏵ / ◉ chrome.
    const screen = [
      '────────────────────────────────────────',
      '❯ Try "edit <filepath> to..."',
      '────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)     ◉ xhigh · /effort',
    ].join('\n');
    expect(classifyScreen(screen)).toBeNull();
  });

  it('handles cursor-positioning-stripped output where marker + number + label have no spaces', () => {
    // After ANSI/CSI strip of a TUI that positions characters via cursor
    // moves, the lines look like "❯1.Yes,andbypasspermissions" — no space
    // between the marker, the number, or the label. The classifier must
    // still recognise this as a numbered menu.
    const screen = [
      'Claude has written up a plan and is ready to execute. Would you like to proceed?',
      '❯1.Yes,andbypasspermissions',
      '2.Yes,manuallyapproveedits',
      '3.No,refinewithUltraplanonClaudeCodeontheweb',
      '4.TellClaudewhattochange',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('numbered');
    expect(r.options).toHaveLength(4);
    expect(r.options[0].key).toBe('1');
  });

  it('still returns arrow-menu when there IS a real question above the marker', () => {
    const screen = [
      'Which model would you like to use?',
      '❯ Sonnet',
      '  Opus',
      '  Haiku',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('arrow-menu');
  });
});

describe('PromptDetector', () => {
  it('emits prompt event after idle when a prompt is on screen', async () => {
    const det = new PromptDetector({ idleMs: 60 });
    const events = [];
    det.on('prompt', p => events.push(p));
    det.feed('Continue? [y/N]');
    await new Promise(r => setTimeout(r, 200));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('yes-no');
  });

  it('does not emit the same prompt twice on subsequent ticks', async () => {
    const det = new PromptDetector({ idleMs: 40 });
    const events = [];
    det.on('prompt', p => events.push(p));
    det.feed('Continue? [y/N]');
    await new Promise(r => setTimeout(r, 100));
    // Same prompt content arrives again (e.g. TUI redraws on resize).
    det.feed('Continue? [y/N]');
    await new Promise(r => setTimeout(r, 100));
    expect(events).toHaveLength(1);
  });

  it('emits again after reset()', async () => {
    const det = new PromptDetector({ idleMs: 40 });
    const events = [];
    det.on('prompt', p => events.push(p));
    det.feed('Continue? [y/N]');
    await new Promise(r => setTimeout(r, 100));
    det.reset();
    det.feed('Continue? [y/N]');
    await new Promise(r => setTimeout(r, 100));
    expect(events).toHaveLength(2);
  });

  it('strips ANSI before classification', async () => {
    const det = new PromptDetector({ idleMs: 40 });
    const events = [];
    det.on('prompt', p => events.push(p));
    det.feed('\x1b[31mContinue?\x1b[0m \x1b[1m[y/N]\x1b[0m');
    await new Promise(r => setTimeout(r, 100));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('yes-no');
  });
});
