// Registry of switchable model aliases (shown as buttons for the no-arg
// /model) plus validation/labelling for `/model <arg>`. The in-TUI
// `/model <alias>` command applies immediately with no picker (Claude Code
// docs), so the bridge validates here then drives the alias into the PTY.

export const SWITCHABLE_ALIASES = [
  { alias: 'default',    label: 'Default' },
  { alias: 'opus',       label: 'Opus' },
  { alias: 'opus[1m]',   label: 'Opus 1M' },
  { alias: 'sonnet',     label: 'Sonnet' },
  { alias: 'sonnet[1m]', label: 'Sonnet 1M' },
  { alias: 'haiku',      label: 'Haiku' },
  { alias: 'opusplan',   label: 'Opus Plan' },
  { alias: 'fable',      label: 'Fable' },
];

// 'best' is valid to type but not surfaced as a button.
const KNOWN_ALIASES = new Set([...SWITCHABLE_ALIASES.map(m => m.alias), 'best']);

// Full model names like claude-opus-4-8 or claude-opus-4-8[1m].
const FULL_NAME_RE = /^claude-[a-z0-9.-]+(\[1m\])?$/;

export const VALID_ALIAS_HINT = SWITCHABLE_ALIASES.map(m => m.alias).join(', ');

export function normalizeModelArg(arg) {
  return String(arg ?? '').trim().toLowerCase();
}

export function isValidModelArg(arg) {
  const a = normalizeModelArg(arg);
  if (!a) return false;
  return KNOWN_ALIASES.has(a) || FULL_NAME_RE.test(a);
}

export function aliasLabel(arg) {
  const a = normalizeModelArg(arg);
  const found = SWITCHABLE_ALIASES.find(m => m.alias === a);
  if (found) return found.label;
  if (a === 'best') return 'Best';
  return a;
}

// Current model is read off any event carrying message.model (assistant /
// tools_changed records in both print and iv mode). Returns null otherwise.
export function modelFromEvent(event) {
  const m = event?.message?.model;
  return typeof m === 'string' && m ? m : null;
}
