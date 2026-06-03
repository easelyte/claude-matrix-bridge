import { describe, it, test, expect } from 'vitest';
import { classifyScreen, stripAnsi, stripInputBox, PromptDetector } from '../lib/prompt-detector.js';

describe('stripAnsi', () => {
  it('removes color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });
  it('removes cursor movements and modes', () => {
    expect(stripAnsi('\x1b[2J\x1b[H\x1b[?25lhello\x1b[?25h')).toBe('hello');
  });
  it('removes CSI sequences with intermediates or non-letter finals', () => {
    expect(stripAnsi('\x1b[4 q1. Yes')).toBe('1. Yes');
    expect(stripAnsi('\x1b[1~1. Yes')).toBe('1. Yes');
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

  it('replaces CSI cursor-down (\\x1b[<n>B / \\x1b[<n>E) with newlines', () => {
    // claude renders the /login menu with `\r\x1b[1B<text>` between options
    // — without converting cursor-down to newlines the whole menu collapses
    // onto a single line and NUMBERED_LINE_RE never matches.
    expect(stripAnsi('Login:\r\x1b[1B1. Pro\r\x1b[1B2. Console\r\x1b[1B3. Bedrock'))
      .toBe('Login:\n1. Pro\n2. Console\n3. Bedrock');
    // CSI E (next line) is equivalent.
    expect(stripAnsi('a\x1b[1Eb\x1b[1Ec')).toBe('a\nb\nc');
    // No digits = 1 line.
    expect(stripAnsi('a\x1b[Bb')).toBe('a\nb');
  });
});

describe('stripAnsi — CHA (Cursor Horizontal Absolute) word-boundary fixtures', () => {
  // These fixtures reproduce the bytes Claude's TUI emits when positioning text
  // within a visual row using CSI CHA (\x1b[<n>G) instead of literal spaces.
  // The old regex-chain stripAnsi deleted \x1b[nG with no replacement, collapsing
  // all inter-word gaps to nothing. The new column-aware pass converts CHA to
  // the correct number of padding spaces so classifyScreen sees readable text.

  test('spec exact bytes: CHA-positioned option label reconstructs word-separated text', () => {
    // From the spec/plan — the literal byte sequence for resume option 2.
    // ^[[5G^[[38;5;246m2.^[[8G^[[39mResume^[[15Gfull^[[20Gsession^[[28Gas-is
    // Without CHA→spaces this collapses to "2.Resumefullsessionas-is".
    const specBytes =
      '\x1b[5G\x1b[38;5;246m2.\x1b[8G\x1b[39mResume\x1b[15Gfull\x1b[20Gsession\x1b[28Gas-is';
    const result = stripAnsi(specBytes);
    expect(result).toContain('Resume full session as-is');
  });

  test('CHA forward-only: pads to target column when target > current col', () => {
    // col starts at 1; CHA 5 → 4 spaces; 'Hello' → col 10; CHA 11 → 1 space; 'world'
    expect(stripAnsi('\x1b[5GHello\x1b[11Gworld')).toBe('    Hello world');
  });

  test('CHA no-rewrite (A1): back-positioning does not erase previously emitted text', () => {
    // col=1; 'Hello' → col 6; CHA 3 ≤ col 6 → only repositions, emits nothing.
    // Output keeps 'Hello' intact, 'World' follows without gap.
    const result = stripAnsi('Hello\x1b[3GWorld');
    expect(result).toBe('HelloWorld');
  });

  test('CHA col cap: target clamped to COL_CAP (120), not beyond terminal width', () => {
    // CHA 200 must clamp to 120; starting at col 1 → 119 spaces before 'End'.
    const result = stripAnsi('\x1b[200GEnd');
    expect(result).toBe(' '.repeat(119) + 'End');
  });

  test('CHA 0 clamps to 1: degenerate param treated as column 1', () => {
    // n=0 should clamp to 1; starting at col=1 → target=col → no pad.
    expect(stripAnsi('\x1b[0GHello')).toBe('Hello');
  });

  test('cursor-forward cap is MAX_FWD_SPACES (80), distinct from CHA cap (120)', () => {
    // Cursor-forward 81 → capped at 80; CHA 121 → capped at 120 (not 80).
    // The two caps are intentionally different constants.
    expect(stripAnsi('\x1b[81Cy')).toBe(' '.repeat(80) + 'y');
    // CHA 121 from col=1 → clamp to 120 → 119 spaces
    expect(stripAnsi('\x1b[121GEnd')).toBe(' '.repeat(119) + 'End');
  });

  test('resume menu fixture: CHA-positioned option labels reconstruct with spaces', () => {
    // Mirrors real PTY bytes for Claude's session-resume menu.
    // The ❯ marker causes the numbered detector to accept the run.
    const raw = [
      'This\x1b[6Gsession\x1b[14Gis\x1b[17G14h\x1b[21G16m\x1b[25Gold.',
      'What\x1b[6Gwould\x1b[12Gyou\x1b[16Glike\x1b[21Gto\x1b[24Gdo?',
      '❯ 1.\x1b[5GResume\x1b[12Gfrom\x1b[17Gsummary',
      '  2.\x1b[5GResume\x1b[12Gfull\x1b[17Gsession\x1b[25Gas-is',
      '  3.\x1b[5GStart\x1b[11Gnew\x1b[15Gsession',
    ].join('\n');
    const stripped = stripAnsi(raw);
    // Every word gap must be present (not collapsed).
    expect(stripped).toContain('This session');
    expect(stripped).toContain('14h 16m old');
    expect(stripped).toContain('Resume full session as-is');
    expect(stripped).toContain('Start new session');
  });

  test('resume menu fixture: classifyScreen returns correct kind/question/options', () => {
    const raw = [
      'This\x1b[6Gsession\x1b[14Gis\x1b[17G14h\x1b[21G16m\x1b[25Gold.',
      'What\x1b[6Gwould\x1b[12Gyou\x1b[16Glike\x1b[21Gto\x1b[24Gdo?',
      '❯ 1.\x1b[5GResume\x1b[12Gfrom\x1b[17Gsummary',
      '  2.\x1b[5GResume\x1b[12Gfull\x1b[17Gsession\x1b[25Gas-is',
      '  3.\x1b[5GStart\x1b[11Gnew\x1b[15Gsession',
    ].join('\n');
    const r = classifyScreen(stripAnsi(raw));
    expect(r).not.toBeNull();
    expect(r.kind).toBe('numbered');
    expect(r.question).toContain('session is 14h 16m old');
    expect(r.options).toHaveLength(3);
    expect(r.options[1].label).toContain('Resume full session as-is');
    expect(r.options[2].label).toContain('Start new session');
  });

  test('plan-mode confirmation fixture: CHA-positioned text reconstructs with spaces', () => {
    // Mirrors the plan-mode confirm menu where the session-age question
    // and option labels are positioned via CHA.
    const raw = [
      'This\x1b[6Gsession\x1b[14Gis\x1b[17G14h\x1b[21G16m\x1b[25Gold.',
      'Claude\x1b[8Ghas\x1b[12Gwritten\x1b[20Gup\x1b[23Ga\x1b[25Gplan.',
      'Would\x1b[7Gyou\x1b[11Glike\x1b[16Gto\x1b[19Gproceed?',
      '❯ 1.\x1b[6GYes,\x1b[11Gand\x1b[15Gbypass\x1b[22Gpermissions',
      '  2.\x1b[6GYes,\x1b[11Gmanually\x1b[20Gapprove\x1b[28Gedits',
      '  3.\x1b[6GNo,\x1b[10Grefine\x1b[17Gwith\x1b[22GUltraplan',
      '  4.\x1b[6GTell\x1b[11GClaude\x1b[18Gwhat\x1b[23Gto\x1b[26Gchange',
    ].join('\n');
    const stripped = stripAnsi(raw);
    expect(stripped).toContain('This session is 14h 16m old');
    expect(stripped).toContain('Claude has written up a plan');
    expect(stripped).toContain('Would you like to proceed');
    expect(stripped).toContain('Yes, and bypass permissions');
    expect(stripped).toContain('Tell Claude what to change');
  });

  test('plan-mode confirmation fixture: classifyScreen returns kind/question/options/freeTextIdx', () => {
    const raw = [
      'This\x1b[6Gsession\x1b[14Gis\x1b[17G14h\x1b[21G16m\x1b[25Gold.',
      'Claude\x1b[8Ghas\x1b[12Gwritten\x1b[20Gup\x1b[23Ga\x1b[25Gplan.',
      'Would\x1b[7Gyou\x1b[11Glike\x1b[16Gto\x1b[19Gproceed?',
      '❯ 1.\x1b[6GYes,\x1b[11Gand\x1b[15Gbypass\x1b[22Gpermissions',
      '  2.\x1b[6GYes,\x1b[11Gmanually\x1b[20Gapprove\x1b[28Gedits',
      '  3.\x1b[6GNo,\x1b[10Grefine\x1b[17Gwith\x1b[22GUltraplan',
      '  4.\x1b[6GTell\x1b[11GClaude\x1b[18Gwhat\x1b[23Gto\x1b[26Gchange',
    ].join('\n');
    const r = classifyScreen(stripAnsi(raw));
    expect(r).not.toBeNull();
    expect(r.kind).toBe('numbered');
    expect(r.question).toContain('This session is 14h 16m old');
    expect(r.options).toHaveLength(4);
    expect(r.options[0].label).toContain('Yes, and bypass permissions');
    expect(r.options[1].label).toContain('Yes, manually approve edits');
    expect(r.freeTextIdx).toBe(3);
  });

  test('AskUserQuestion menu fixture: CHA-positioned labels reconstruct with spaces', () => {
    // Mirrors an AskUserQuestion-style numbered menu where each option label
    // is built with CHA moves between individual words.
    const raw = [
      'Which\x1b[7Gapproach\x1b[16Gdo\x1b[19Gyou\x1b[23Gprefer?',
      '❯ 1.\x1b[6GBake\x1b[11Gshould\x1b[18Gmatch\x1b[24Geditor',
      '  2.\x1b[6GEditor\x1b[13Gshould\x1b[20Gmatch\x1b[26Gbake',
      '  3.\x1b[6GNot\x1b[10Gsure',
      '  4.\x1b[6GTell\x1b[11GClaude\x1b[18Gwhat\x1b[23Gto\x1b[26Gchange',
    ].join('\n');
    const stripped = stripAnsi(raw);
    expect(stripped).toContain('Which approach do you prefer');
    expect(stripped).toContain('Bake should match editor');
    expect(stripped).toContain('Editor should match bake');
  });

  test('AskUserQuestion menu fixture: classifyScreen returns correct kind/question/options', () => {
    const raw = [
      'Which\x1b[7Gapproach\x1b[16Gdo\x1b[19Gyou\x1b[23Gprefer?',
      '❯ 1.\x1b[6GBake\x1b[11Gshould\x1b[18Gmatch\x1b[24Geditor',
      '  2.\x1b[6GEditor\x1b[13Gshould\x1b[20Gmatch\x1b[26Gbake',
      '  3.\x1b[6GNot\x1b[10Gsure',
      '  4.\x1b[6GTell\x1b[11GClaude\x1b[18Gwhat\x1b[23Gto\x1b[26Gchange',
    ].join('\n');
    const r = classifyScreen(stripAnsi(raw));
    expect(r).not.toBeNull();
    expect(r.kind).toBe('numbered');
    expect(r.question).toContain('Which approach do you prefer');
    expect(r.options).toHaveLength(4);
    expect(r.options[0].label).toContain('Bake should match editor');
    expect(r.options[1].label).toContain('Editor should match bake');
    expect(r.options[3].label).toContain('Tell Claude what to change');
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

  it('detects menu options after cursor-shape or key-style CSI sequences', () => {
    for (const csi of ['\x1b[4 q', '\x1b[1~']) {
      const screen = stripAnsi([
        'Pick one:',
        `${csi}1. Yes`,
        '2. No',
      ].join('\n'));
      const r = classifyScreen(screen);
      expect(r).not.toBeNull();
      expect(r.kind).toBe('numbered');
      expect(r.options.map(o => o.label)).toEqual(['Yes', 'No']);
    }
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

describe('classifyScreen — /login menu rendered with cursor-down', () => {
  // Real reproduction from claude's /login screen: every option is printed
  // as `\r\x1b[1B<text>` rather than a literal newline, so without the
  // cursor-down → newline conversion in stripAnsi the whole menu collapses
  // to one line and the bridge never surfaces it over Matrix.
  it('detects the 3-option login menu after stripAnsi inserts newlines', () => {
    // Real byte sequence: claude moves between rendered rows with CR + CSI
    // cursor-down (`\r\x1b[1B`) instead of literal `\n`. The screen below
    // mimics that exactly for the question + options portion of the menu.
    const screen =
      'Login' +
      '\r\x1b[1B  Claude Code can be used with your Claude subscription or billed based on API usage.' +
      '\r\x1b[1B  Select login method:' +
      '\r\x1b[1B❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise' +
      '\r\x1b[1B  2. Anthropic Console account · API usage billing' +
      '\r\x1b[1B  3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI';
    const r = classifyScreen(stripAnsi(screen));
    expect(r).not.toBeNull();
    expect(r.kind).toBe('numbered');
    expect(r.options).toHaveLength(3);
    expect(r.options[0].label).toMatch(/Claude account with subscription/);
    expect(r.options[1].label).toMatch(/Anthropic Console/);
    expect(r.options[2].label).toMatch(/3rd-party/);
    expect(r.question).toMatch(/Select login method/);
  });
});

describe('classifyScreen — full question text for multi-line modals', () => {
  // Real reproduction from the bypass-permissions warning modal that the
  // bridge surfaces over Matrix. Old detector took only 2 lines above the
  // menu, so the question shown in Matrix was just the URL line, leaving
  // the user with no idea what they were agreeing to.
  it('includes the WARNING + explanation paragraphs from the bypass-permissions modal', () => {
    const screen = [
      '────────────────────────────────────────',
      'WARNING: Claude Code running in Bypass Permissions mode',
      '',
      'In Bypass Permissions mode, Claude Code will not ask for your approval',
      'before running potentially dangerous commands.',
      'This mode should only be used in a sandboxed container/VM that has',
      'restricted internet access and can easily be restored if damaged.',
      '',
      'By proceeding, you accept all responsibility for actions taken while',
      'running in Bypass Permissions mode.',
      '',
      'https://code.claude.com/docs/en/security',
      '',
      '❯ 1. No, exit',
      '  2. Yes, I accept',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('numbered');
    expect(r.options.map(o => o.label)).toEqual(['No, exit', 'Yes, I accept']);
    // The WARNING line and at least one explanation line must be in the
    // question — that's the whole point of this regression test.
    expect(r.question).toMatch(/WARNING.*Bypass Permissions mode/);
    expect(r.question).toMatch(/sandbox|responsibility|approval/);
    expect(r.question).toMatch(/https:\/\/code\.claude\.com/);
  });

  it('stops walking up at a separator line so prior screens do not leak in', () => {
    // The screen above the modal (status bar, previous prompt) is
    // separated from the modal by a row of ─ chars. We must not absorb
    // it into the question.
    const screen = [
      'Some unrelated previous text that should NOT appear',
      '────────────────────────────────────────',
      'Pick one:',
      '1. Foo',
      '2. Bar',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.question).toMatch(/Pick one/);
    expect(r.question).not.toMatch(/unrelated previous text/);
  });
});

describe('classifyScreen — first option glued onto heading line', () => {
  // Real reproduction from claude's theme picker on a fresh box: claude's TUI
  // renders option 1 ("Auto (match terminal)") on the same visual line as
  // the heading "To change this later, run /theme", with options 2..N on
  // their own lines. Naive detection sees a numbered run starting at 2
  // and absorbs "1. Auto" into the question text. The user then picks "1"
  // expecting Auto but the bridge sends keystroke "2" (Dark mode).
  it('recovers the first numbered option when it is glued onto the heading', () => {
    const screen = [
      'To change this later, run /theme  1. Auto (match terminal)',
      '2. Dark mode ✔ (current)',
      '3. Light mode',
      '4. Dark mode (colorblind-friendly)',
      '5. Light mode (colorblind-friendly)',
      '6. Dark mode (ANSI colors only)',
      '7. Light mode (ANSI colors only)',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('numbered');
    expect(r.options.map(o => o.key)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(r.options[0].label).toMatch(/^Auto \(match terminal\)/);
    expect(r.options[1].label).toMatch(/^Dark mode/);
    // Question should NOT contain the absorbed first option.
    expect(r.question).not.toMatch(/Auto \(match terminal\)/);
    expect(r.question).toMatch(/\/theme/);
  });

  it('anchors on the LAST "1." in the heading line when it has stray earlier numerals', () => {
    // If the heading text legitimately contains "1." or "1)" before the
    // glued first option, a non-greedy match would absorb the heading tail
    // into the option label. Greedy match anchors on the last "1.".
    const screen = [
      'Step 1. Pick a theme  1. Auto (match terminal)',
      '2. Dark mode ✔ (current)',
      '3. Light mode',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('numbered');
    expect(r.options.map(o => o.key)).toEqual(['1', '2', '3']);
    expect(r.options[0].label).toBe('Auto (match terminal)');
    expect(r.question).toMatch(/Step 1\. Pick a theme$/);
  });

  it('does not invent a phantom first option when nothing precedes the run', () => {
    // Guard: a clean numbered run starting at 2 with no glued heading
    // shouldn't suddenly grow a fake option 1 from unrelated text above.
    const screen = [
      'Some unrelated paragraph with no numbered tail.',
      '2. Foo',
      '3. Bar',
    ].join('\n');
    const r = classifyScreen(screen);
    if (r) {
      // If we still classify, options must reflect what was actually on
      // screen; we should not synthesise a "1." from the heading.
      expect(r.options.map(o => o.key)).not.toContain('1');
    }
  });
});

describe('classifyScreen — selection marker on a non-first item', () => {
  // Real capture from running the `/theme` slash command in claude's TUI:
  // option 1 is on its own line (no glued heading), the heading
  // ("Choose the text style…") has no trailing `?` or `:`, and the `❯`
  // cursor sits on the CURRENT selection (option 2) — not option 1.
  // The earlier `firstItemMarked` check only looked at the run's first
  // line, so all three gate conditions failed and the picker was missed,
  // which left iv-mode sessions hung with no surfaced menu.
  it('classifies the /theme runtime picker (cursor on option 2)', () => {
    // Indentation matches an actual PTY capture: option 1 sits flush left,
    // the cursor line `❯ 2.` is indented by two columns, options 3..N
    // return to flush-left. The mismatched indent makes the arrow-menu
    // detector reject the run (siblings out-dent the marker), so the
    // numbered detector is the only thing that can catch this picker.
    const screen = [
      'Theme',
      '',
      'Choose the text style that looks best with your terminal',
      '',
      '1. Auto (match terminal)',
      '  ❯ 2. Dark mode ✔',
      '3. Light mode',
      '4. Dark mode (colorblind-friendly)',
      '5. Light mode (colorblind-friendly)',
      '6. Dark mode (ANSI colors only)',
      '7. Light mode (ANSI colors only)',
      '8. New custom theme…',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('numbered');
    expect(r.options.map(o => o.key)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(r.options[0].label).toMatch(/^Auto \(match terminal\)/);
    expect(r.options[1].label).toMatch(/^Dark mode/);
    expect(r.question).toMatch(/Choose the text style/);
  });

  it('classifies a lettered run when the cursor sits on a later option', () => {
    // Same shape as the numbered case: the cursor line is indented but the
    // surrounding option lines are flush left, so arrow-menu detection
    // bails on the indent mismatch and the lettered detector must accept
    // the run on the strength of the `❯` marker alone.
    const screen = [
      'Pick a flavour',
      'a) Vanilla',
      '  ❯ b) Chocolate',
      'c) Strawberry',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('lettered');
    expect(r.options.map(o => o.key)).toEqual(['a', 'b', 'c']);
  });
});

describe('classifyScreen — numbered menu with description sub-lines between options', () => {
  // Real reproduction from a Claude AskUserQuestion-style prompt. Each
  // numbered option has one or more indented description lines underneath
  // (and sometimes blank lines between options). Previously each numbered
  // line was a length-1 run so the numbered detector skipped them all,
  // and the arrow-menu fallback slurped the descriptions as siblings —
  // surfacing 9 "options" instead of 4.
  it('detects 4 numbered options even when description lines interleave', () => {
    const screen = [
      "match the editor's Arial+canvas layout exactly, or should the editor switch to Liberation+opentype to match the bake? Which direction do you want?",
      '❯ 1. Bake should match editor (Arial layout)',
      '  Change buildEntryPathData and the CLI to use Arial canvas measurements (or simulate them with opentype using the',
      '  right metrics) so bakes match what users saw in preview.',
      '',
      '  2. Editor should match bake (Liberation paths)',
      '  Change useNumberDesignJsx/computeMaxFontSize/packer to size names using opentype Liberation Sans metrics so the',
      '  editor preview matches the bake output.',
      '',
      '  3. Not sure — let me investigate first',
      "  I'll dig into the editor/bake code paths and report back with a recommendation before making changes.",
      '',
      '  4. Type something.',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('numbered');
    expect(r.options).toHaveLength(4);
    expect(r.options.map(o => o.key)).toEqual(['1', '2', '3', '4']);
    expect(r.options[0].label).toMatch(/^Bake should match editor/);
    expect(r.options[1].label).toMatch(/^Editor should match bake/);
    expect(r.options[2].label).toMatch(/^Not sure/);
    expect(r.options[3].label).toMatch(/^Type something/);
    // Descriptions must NOT become options.
    expect(r.options.map(o => o.label).join('|')).not.toMatch(/buildEntryPathData|useNumberDesignJsx|dig into the editor/);
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

describe('classifyScreen — free-text slot detection', () => {
  it('detects "Tell Claude what to change" as the free-text option in a numbered menu', () => {
    const screen = [
      'Claude has written up a plan and is ready to execute. Would you like to proceed?',
      '❯ 1. Yes, and bypass permissions',
      '  2. Yes, manually approve edits',
      '  3. No, refine with Ultraplan',
      '  4. Tell Claude what to change',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.freeTextIdx).toBe(3);
  });

  it('returns freeTextIdx null when the last option is not a free-text slot', () => {
    const screen = [
      'Choose a model:',
      '  1) Sonnet',
      '  2) Opus',
      '  3) Haiku',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.freeTextIdx).toBeNull();
  });

  it('yes/no prompts always have freeTextIdx null', () => {
    const r = classifyScreen('Continue? [y/N]');
    expect(r.freeTextIdx).toBeNull();
  });

  it('detects free-text in arrow-menu prompts', () => {
    const screen = [
      'Pick a follow-up:',
      '❯ Run tests',
      '  Skip tests',
      '  Edit the plan',
    ].join('\n');
    const r = classifyScreen(screen);
    expect(r).not.toBeNull();
    expect(r.kind).toBe('arrow-menu');
    expect(r.freeTextIdx).toBe(2);
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

  it('returns null on tool-call status lines with ⎿ tree chrome (arrow-menu false positive)', () => {
    // Reproduces a misdetection observed in iv-mode: claude's TUI shows a
    // slash-command picker (❯ /compact) followed by tool-call status
    // lines (`⎿ Read foo.md`, `⎿ Referenced file ...`). The arrow-menu
    // detector read every ⎿ line as a sibling menu item, surfacing a
    // 10-option "question" to Matrix.
    const screen = [
      'Should this be a separate ticket?',
      '❯ /compact                              (current)',
      '  ⎿ Compacted (ctrl+o to see full summary)',
      '  PreCompact [/home/x/hooks/compact-notify.sh] completed successfully',
      '  ⎿ Referenced file src/YM/HoodieBundle/Service/HoodieDesignService.php',
      '  ⎿ Referenced file src/YM/AdminBundle/Command/RebakeHoodieBackDesignsCommand.php',
      '  ⎿ Read ../.claude/plugins/cache/.../code-quality-reviewer-prompt.md (26 lines)',
    ].join('\n');
    expect(classifyScreen(screen)).toBeNull();
  });

  it('returns null on a numbered run whose items contain ⎿ tree chrome', () => {
    // Defensive: the numbered/lettered detectors now also validate every
    // option via looksLikeRealMenuItem so a tool-call status list under a
    // question line can't be mistaken for a menu.
    const screen = [
      'Pick one:',
      '1. ⎿ Read foo.md',
      '2. ⎿ Read bar.md',
      '3. ⎿ Read baz.md',
    ].join('\n');
    expect(classifyScreen(screen)).toBeNull();
  });

  it('returns null when question text contains TUI chrome glyphs (response text false positive)', () => {
    // Claude's response text can contain numbered lists preceded by garbled
    // status chrome — the ✢ and ● glyphs are TUI decorations, not part of
    // a real interactive prompt. Regression test for a live false positive.
    const screen = [
      '4though for 4s) ✢ · ✢ ●Two issues to fix:',
      '1. Replace the hand-rolled modal with SimpleModal',
      '2. Change em dash to regular hyphen in HoodieSlotNameValues::inputLabel()',
    ].join('\n');
    expect(classifyScreen(screen)).toBeNull();
  });

  it('returns null when question text contains ● (geometric shape chrome)', () => {
    const screen = [
      'Status: ● running — tasks to do:',
      '1. Fix the tests',
      '2. Update the docs',
    ].join('\n');
    expect(classifyScreen(screen)).toBeNull();
  });

  it('returns null on a wrapped prose line read as a 2-item arrow menu (input-box false positive)', () => {
    // Live false positive: the user's long message wraps in claude's input
    // box to `❯ <110+ chars>` + a short continuation, which the arrow-menu
    // detector read as a menu. Wrapped prose exceeds the menu-option length
    // bound, so it must be rejected.
    const screen = [
      'whichever PR(s) you are actually merging?',
      '❯ also can we add a button in the hoodie editor to bake the design using both different bakers so we can quicikly',
      '  compare them?',
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

describe('stripInputBox', () => {
  it('removes the background-filled input field so it is not read as a menu', () => {
    // Claude renders its input box as full-line background-filled rows:
    // `\x1b[48;5;237m\x1b[38;5;239m❯ <text>`. A wrapped/multi-line user
    // message there would otherwise classify as an arrow menu.
    const raw =
      'Some response ending in a question?\r\r\n' +
      '\x1b[48;5;237m\x1b[38;5;239m❯ \x1b[38;5;231mHi there\x1b[39m   \x1b[49m\r\r\n' +
      '\x1b[48;5;237m  \x1b[38;5;231mcan you help me?\x1b[39m   \x1b[49m\r\r\n';
    // Without stripping, this is a false-positive arrow menu.
    expect(classifyScreen(stripAnsi(raw))).not.toBeNull();
    // With stripping, the input field is gone and nothing classifies.
    expect(classifyScreen(stripAnsi(stripInputBox(raw)))).toBeNull();
  });

  it('keeps a genuinely highlighted numbered menu option', () => {
    // The selected option in a real numbered menu can be background-filled
    // too — but it has a number after the marker, so it must survive.
    const raw =
      'Would you like to proceed?\r\r\n' +
      '\x1b[48;5;237m\x1b[38;5;231m❯ 1. Yes, and bypass permissions\x1b[49m\r\r\n' +
      '  2. No, refine\r\r\n';
    const r = classifyScreen(stripAnsi(stripInputBox(raw)));
    expect(r).not.toBeNull();
    expect(r.kind).toBe('numbered');
    expect(r.options.map(o => o.label)).toEqual(['Yes, and bypass permissions', 'No, refine']);
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
