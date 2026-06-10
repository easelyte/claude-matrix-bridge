import { describe, it, expect } from 'vitest';
import {
  SWITCHABLE_ALIASES,
  VALID_ALIAS_HINT,
  isValidModelArg,
  normalizeModelArg,
  aliasLabel,
  modelFromEvent,
} from '../lib/model-aliases.js';

describe('SWITCHABLE_ALIASES', () => {
  it('lists the eight switchable models with labels', () => {
    expect(SWITCHABLE_ALIASES.map(m => m.alias)).toEqual([
      'default', 'opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'opusplan', 'fable',
    ]);
    for (const m of SWITCHABLE_ALIASES) expect(typeof m.label).toBe('string');
  });
});

describe('isValidModelArg', () => {
  it('accepts known aliases case-insensitively', () => {
    expect(isValidModelArg('sonnet')).toBe(true);
    expect(isValidModelArg('OPUS')).toBe(true);
    expect(isValidModelArg('opusplan')).toBe(true);
    expect(isValidModelArg('best')).toBe(true);
  });
  it('accepts [1m] long-context variants', () => {
    expect(isValidModelArg('opus[1m]')).toBe(true);
    expect(isValidModelArg('sonnet[1m]')).toBe(true);
  });
  it('accepts full claude-* model names (with optional [1m])', () => {
    expect(isValidModelArg('claude-opus-4-8')).toBe(true);
    expect(isValidModelArg('claude-opus-4-8[1m]')).toBe(true);
  });
  it('rejects unknown garbage', () => {
    expect(isValidModelArg('banana')).toBe(false);
    expect(isValidModelArg('')).toBe(false);
    expect(isValidModelArg(undefined)).toBe(false);
  });
});

describe('normalizeModelArg', () => {
  it('trims and lower-cases', () => {
    expect(normalizeModelArg('  Sonnet ')).toBe('sonnet');
    expect(normalizeModelArg('OPUS[1M]')).toBe('opus[1m]');
  });
});

describe('aliasLabel', () => {
  it('returns the pretty label for a known alias', () => {
    expect(aliasLabel('opusplan')).toBe('Opus Plan');
    expect(aliasLabel('opus[1m]')).toBe('Opus 1M');
  });
  it('falls back to the raw arg for full names', () => {
    expect(aliasLabel('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});

describe('VALID_ALIAS_HINT', () => {
  it('is a comma-separated hint of switchable aliases', () => {
    expect(VALID_ALIAS_HINT).toContain('sonnet');
    expect(VALID_ALIAS_HINT).toContain('opusplan');
  });
});

describe('modelFromEvent', () => {
  it('reads message.model from an assistant-shaped event', () => {
    expect(modelFromEvent({ message: { model: 'claude-opus-4-8' } })).toBe('claude-opus-4-8');
  });
  it('returns null when there is no model', () => {
    expect(modelFromEvent({ type: 'system', subtype: 'init' })).toBe(null);
    expect(modelFromEvent(null)).toBe(null);
    expect(modelFromEvent({ message: {} })).toBe(null);
  });
});
