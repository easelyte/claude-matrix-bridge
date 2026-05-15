import { EventEmitter } from 'node:events';

// Strip ANSI escape sequences plus all CR (which the TUI uses to overwrite
// the current line; CR-LF is normalised to LF).
//
// claude's TUI uses CSI cursor-forward (`\x1b[<n>C`) for visual gaps between
// words/columns instead of writing literal spaces — so the option label
// "Yes, manually approve edits" comes through as bytes like
// `Yes,\x1b[1Cmanually\x1b[1Capprove\x1b[1Cedits`. Naively stripping all
// ANSI loses every space. We convert cursor-forward escapes to N spaces
// BEFORE the general strip so the visible text reads correctly. Other CSI
// (colour, cursor up/down/back, screen clears) is dropped with no
// replacement.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b[@-_]|\x1b\][^\x07]*\x07/g;
// eslint-disable-next-line no-control-regex
const CURSOR_FORWARD_RE = /\x1b\[(\d*)C/g;
const CR_RE = /\r/g;

export function stripAnsi(s) {
  // Cap the substitution at 80 columns to avoid pathological cursor moves
  // ballooning the buffer.
  const withSpaces = s.replace(CURSOR_FORWARD_RE, (_, n) => ' '.repeat(Math.min(parseInt(n, 10) || 1, 80)));
  return withSpaces.replace(ANSI_RE, '').replace(CR_RE, '');
}

const YN_RE = /[[(]\s*[yY]\s*\/\s*[Nn]\s*[\])]|[[(]\s*[Yy]\s*\/\s*[nN]\s*[\])]/;
// The TUI uses cursor-positioning escapes between menu marker, number, and
// label rather than literal spaces — after ANSI strip the line looks like
// `❯1.Yes,andbypasspermissions`. Allow zero spaces after every separator.
// Also accept an optional menu marker (❯ etc.) before the number/letter so
// the "current selection" line still parses as a numbered/lettered item.
const NUMBERED_LINE_RE = /^[\s❯>▶►]*(\d+)[.)]\s*(.+)$/;
const LETTERED_LINE_RE = /^[\s❯>▶►]*\(?([a-zA-Z])\)?[.)]\s*(.+)$/;
const ARROW_MARKER_RE = /^(\s*)([❯>▶►])\s*(.+)$/;

// Lines that look like UI chrome rather than real menu options. The TUI
// renders separators (box drawing), status bars (⏵⏵, ◉), and so on around
// the input area; misreading these as menu items produces false positives
// the moment claude paints its welcome screen.
const SEPARATOR_RE = /^[-=_─-╿▀-▟‐-―]+$/;
const CHROME_RE = /[⏴-⏺◀-◿⬅-⬍]|⏵⏴|◉|◯|·\s+\//;

function looksLikeRealMenuItem(text) {
  if (!text) return false;
  if (SEPARATOR_RE.test(text)) return false;
  if (CHROME_RE.test(text)) return false;
  // Reject lines that are mostly non-alphanumeric (status bars, art).
  const alnum = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  if (alnum < 2 || alnum / text.length < 0.3) return false;
  return true;
}

// Keyboard-shortcut hints that the TUI shows alongside a menu (e.g. "shift+tab
// to approve with this feedback", "ctrl-g to edit in VS Code"). These look
// like real menu items by length/alnum but shouldn't be presented to the
// user as choices.
const KEYBOARD_HINT_RE = /\b(shift\+?tab|ctrl[+-]?[a-z]|alt[+-]?[a-z]|esc(?:ape)?|enter|return)\b\s+to\s+\w/i;

function isKeyboardHintLine(text) {
  return KEYBOARD_HINT_RE.test(text);
}

// How many trailing lines of the stripped screen to consider when looking
// for a prompt. The PTY buffer accumulates many overlapping redraws — when
// claude's TUI repaints a status line every spinner tick the older content
// piles up in the byte stream. Only the bottom of that stream reflects what
// the user can currently see, so restrict classification to roughly one
// screen-worth of trailing lines.
const SCREEN_TAIL_LINES = 50;

// Classify a screen (already ANSI-stripped) as one of the prompt kinds we
// know how to respond to. Returns `null` if the screen does not look like a
// prompt — false negatives are preferred over false positives, since false
// positives spam Matrix with "claude is asking" messages mid-response.
export function classifyScreen(screen) {
  if (!screen) return null;
  const allLines = screen.split('\n').map(l => l.trimEnd());
  // Restrict to the bottom of the buffer so older redraws don't contaminate
  // the match (e.g. an old ❯ from a prior screen above the actual prompt).
  const lines = allLines.slice(-SCREEN_TAIL_LINES);

  // Yes/No — search the whole screen (it can appear in the middle of an
  // explanation, not necessarily on the last line).
  if (YN_RE.test(screen)) {
    const matchLineIdx = lines.findIndex(l => YN_RE.test(l));
    const question = lines.slice(Math.max(0, matchLineIdx - 1), matchLineIdx + 1).join(' ').trim();
    return {
      kind: 'yes-no',
      question: question.replace(YN_RE, '').trim() || question,
      options: [
        { key: 'y', label: 'Yes' },
        { key: 'n', label: 'No' },
      ],
    };
  }

  // Numbered selection. The buffer can contain multiple numbered runs (e.g.
  // a numbered list inside plan prose AND the bypass-permissions confirmation
  // menu); look at every run and pick the one that passes the menu guard,
  // preferring runs closer to the bottom of the screen.
  {
    const runs = collectAllRuns(lines, NUMBERED_LINE_RE);
    for (const run of runs.reverse()) {
      if (run.length < 2) continue;
      const opts = run.matches.map(m => ({ key: m[1], label: m[2].trim() }));
      const above = lines.slice(Math.max(0, run.startIdx - 2), run.startIdx).map(l => l.trim()).filter(Boolean);
      const question = above.join(' ').trim();
      const aboveLooksInterrogative = /[?:]\s*$/.test(question);
      const firstItemMarked = /^[\s]*[❯>▶►]/.test(lines[run.startIdx] || '');
      if (aboveLooksInterrogative || firstItemMarked) {
        return { kind: 'numbered', question, options: opts };
      }
    }
  }

  // Lettered selection — same guard, same all-runs handling.
  {
    const runs = collectAllRuns(lines, LETTERED_LINE_RE);
    for (const run of runs.reverse()) {
      if (run.length < 2) continue;
      const opts = run.matches.map(m => ({ key: m[1].toLowerCase(), label: m[2].trim() }));
      const above = lines.slice(Math.max(0, run.startIdx - 2), run.startIdx).map(l => l.trim()).filter(Boolean);
      const question = above.join(' ').trim();
      const aboveLooksInterrogative = /[?:]\s*$/.test(question);
      const firstItemMarked = /^[\s]*[❯>▶►]/.test(lines[run.startIdx] || '');
      if (aboveLooksInterrogative || firstItemMarked) {
        return { kind: 'lettered', question, options: opts };
      }
    }
  }

  // Arrow menu — a line whose first non-blank is a marker (❯/>/▶), followed
  // by sibling lines at the same indent that look like real menu items.
  // Sibling lines that look like keyboard-shortcut hints (e.g. "shift+tab
  // to approve with this feedback", "ctrl-g to edit in VS Code") get
  // filtered so they don't pollute the menu.
  {
    const markerIdx = lines.findIndex(l => ARROW_MARKER_RE.test(l));
    if (markerIdx >= 0) {
      const m = lines[markerIdx].match(ARROW_MARKER_RE);
      const indent = m[1].length;
      const firstLabel = m[3].trim();
      // Reject when the marker line itself doesn't look like a menu item —
      // catches the false positive where claude's TUI uses ❯ as the input-
      // box prompt indicator surrounded by separators and status chrome.
      if (looksLikeRealMenuItem(firstLabel)) {
        const items = [{ label: firstLabel, selected: true }];
        for (let i = markerIdx + 1; i < lines.length; i++) {
          const line = lines[i];
          const sm = line.match(/^(\s*)(.*)$/);
          if (!sm) break;
          if (sm[1].length < indent) break;
          const rest = sm[2].replace(/^[❯>▶►]\s*/, '').trim();
          if (!rest) break;
          if (!looksLikeRealMenuItem(rest)) break;
          if (isKeyboardHintLine(rest)) break;
          items.push({ label: rest, selected: false });
          if (items.length >= 20) break; // sanity
        }
        if (items.length >= 2) {
          // Require a non-empty plausible question line above the marker.
          // Real menus have a question; the TUI welcome screen doesn't.
          const aboveLines = lines.slice(0, markerIdx).map(l => l.trim()).filter(Boolean);
          const question = aboveLines.slice(-2).join(' ').trim();
          if (question && looksLikeRealMenuItem(question)) {
            return { kind: 'arrow-menu', question, options: items };
          }
        }
      }
    }
  }

  return null;
}

// Find every maximal run of consecutive lines matching `re`. Returns an
// array of { length, matches, startIdx } in document order. Used by the
// numbered and lettered detectors so we can pick the run that actually has
// menu context (question/marker) rather than always taking the longest.
function collectAllRuns(lines, re) {
  const runs = [];
  let cur = [];
  let curStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) {
      if (cur.length === 0) curStart = i;
      cur.push(m);
    } else if (cur.length > 0) {
      runs.push({ length: cur.length, matches: cur, startIdx: curStart });
      cur = [];
      curStart = -1;
    }
  }
  if (cur.length > 0) runs.push({ length: cur.length, matches: cur, startIdx: curStart });
  return runs;
}

// Watches a stream of PTY bytes, accumulates the screen, and emits `prompt`
// events when classifyScreen detects one after a brief idle period. The idle
// gate prevents the detector from firing mid-render (when the screen is
// transiently in an ambiguous state).
export class PromptDetector extends EventEmitter {
  constructor({ idleMs = 300, bufferLimit = 16384 } = {}) {
    super();
    this.idleMs = idleMs;
    this.bufferLimit = bufferLimit;
    this.buf = '';
    this.timer = null;
    this.lastEmitted = null;
  }

  feed(chunk) {
    this.buf += chunk;
    if (this.buf.length > this.bufferLimit) {
      this.buf = this.buf.slice(-this.bufferLimit);
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._check(), this.idleMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  _check() {
    const screen = stripAnsi(this.buf);
    const r = classifyScreen(screen);
    if (!r) return;
    const sig = `${r.kind}::${r.question}::${r.options.map(o => o.label).join('|')}`;
    if (sig === this.lastEmitted) return;
    this.lastEmitted = sig;
    // Clear the accumulated buffer so a subsequent identical re-render of the
    // same prompt classifies to the same signature (and is suppressed). If we
    // kept appending, the question/options text would shift inside a growing
    // screen and the sig would diverge.
    this.buf = '';
    this.emit('prompt', r);
  }

  // Call after responding to a prompt so the SAME prompt text can fire again
  // later (otherwise repeated identical prompts would be silently dropped).
  reset() {
    this.buf = '';
    this.lastEmitted = null;
  }
}
