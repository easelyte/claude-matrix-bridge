import { describe, it, expect } from 'vitest';
import {
  buildMcpServers,
  extractMcpExtraFlags,
  knownMcpExtras,
} from '../lib/mcp-config.js';

const BASE = Object.freeze({
  mcpServers: {
    'ask-user': {
      command: 'node',
      args: ['./ask-user.js'],
      env: { BRIDGE_API_URL: 'http://127.0.0.1:9802' },
    },
  },
  mcpExtras: {
    browser: {
      'chrome-devtools': {
        command: 'xvfb-run',
        args: [
          '--auto-servernum',
          '--server-args=-screen 0 1920x1080x24',
          'npx',
          '-y',
          'chrome-devtools-mcp',
          '--no-usage-statistics',
          '--chromeArg=--no-sandbox',
          '--chromeArg=--disable-setuid-sandbox',
        ],
      },
    },
  },
});

describe('extractMcpExtraFlags', () => {
  it('pulls --browser out of the token list', () => {
    expect(extractMcpExtraFlags(['--browser', '/some/dir']))
      .toEqual({ extras: ['browser'], rest: ['/some/dir'] });
    expect(extractMcpExtraFlags(['/some/dir', '--browser']))
      .toEqual({ extras: ['browser'], rest: ['/some/dir'] });
  });

  it('leaves unknown flags alone', () => {
    expect(extractMcpExtraFlags(['--browser', '--not-a-flag', '/dir']))
      .toEqual({ extras: ['browser'], rest: ['--not-a-flag', '/dir'] });
  });

  it('accepts em-dash / en-dash auto-corrected forms of --browser', () => {
    // Matrix/mobile clients auto-correct a leading "--" into "—" (em-dash),
    // so the user's "--browser" arrives as "—browser".
    expect(extractMcpExtraFlags(['—browser']))
      .toEqual({ extras: ['browser'], rest: [] });
    expect(extractMcpExtraFlags(['–browser', '/dir']))
      .toEqual({ extras: ['browser'], rest: ['/dir'] });
    // A unicode-dash token that isn't a known flag is preserved unchanged.
    expect(extractMcpExtraFlags(['—notaflag']))
      .toEqual({ extras: [], rest: ['—notaflag'] });
  });

  it('returns empty extras when none requested', () => {
    expect(extractMcpExtraFlags(['/dir'])).toEqual({ extras: [], rest: ['/dir'] });
    expect(extractMcpExtraFlags([])).toEqual({ extras: [], rest: [] });
  });

  it('exposes the recognised extras list for sanity checks', () => {
    expect(knownMcpExtras()).toContain('browser');
  });

  // Regression: a plain-object lookup table would silently consume tokens
  // that match Object.prototype member names ("constructor", "toString",
  // "__proto__") because bracket access falls through the prototype chain
  // and returns a truthy function. The Map-backed table avoids this.
  it('does not consume positional args that share Object.prototype names', () => {
    expect(extractMcpExtraFlags(['constructor'])).toEqual({ extras: [], rest: ['constructor'] });
    expect(extractMcpExtraFlags(['toString'])).toEqual({ extras: [], rest: ['toString'] });
    expect(extractMcpExtraFlags(['__proto__'])).toEqual({ extras: [], rest: ['__proto__'] });
    expect(extractMcpExtraFlags(['hasOwnProperty', '--browser']))
      .toEqual({ extras: ['browser'], rest: ['hasOwnProperty'] });
  });
});

describe('buildMcpServers', () => {
  it('returns only the always-on servers when no extras are requested', () => {
    const { config, extras } = buildMcpServers({
      baseConfig: BASE,
      platform: 'linux',
      askUserBaseDir: '/opt/bridge',
    });
    expect(Object.keys(config.mcpServers)).toEqual(['ask-user']);
    expect(config.mcpServers['ask-user'].args[0]).toBe('/opt/bridge/ask-user.js');
    expect(extras).toEqual([]);
  });

  it('merges the browser extra in when requested', () => {
    const { config, extras } = buildMcpServers({
      baseConfig: BASE,
      extras: ['browser'],
      platform: 'linux',
      askUserBaseDir: '/opt/bridge',
    });
    expect(Object.keys(config.mcpServers).sort()).toEqual(['ask-user', 'chrome-devtools']);
    expect(config.mcpServers['chrome-devtools'].command).toBe('xvfb-run');
    expect(extras).toEqual(['browser']);
  });

  it('silently drops unknown extras names rather than letting a typo enable nothing-then-everything', () => {
    const { config, extras } = buildMcpServers({
      baseConfig: BASE,
      extras: ['browser', 'not-a-real-group'],
      platform: 'linux',
      askUserBaseDir: '/opt/bridge',
    });
    expect(Object.keys(config.mcpServers).sort()).toEqual(['ask-user', 'chrome-devtools']);
    expect(extras).toEqual(['browser']);
  });

  it('dedupes repeated extras and returns them sorted (for stable filename hashing)', () => {
    const { extras } = buildMcpServers({
      baseConfig: BASE,
      extras: ['browser', 'browser'],
      platform: 'linux',
    });
    expect(extras).toEqual(['browser']);
  });

  it('unwraps xvfb-run on macOS so the browser MCP actually starts', () => {
    const { config } = buildMcpServers({
      baseConfig: BASE,
      extras: ['browser'],
      platform: 'darwin',
      askUserBaseDir: '/opt/bridge',
    });
    // macifyMcpServers strips the xvfb wrapper + Linux sandbox flags.
    expect(config.mcpServers['chrome-devtools'].command).toBe('npx');
    expect(config.mcpServers['chrome-devtools'].args).not.toContain('--chromeArg=--no-sandbox');
  });

  it('does not mutate the base config', () => {
    const snapshot = JSON.parse(JSON.stringify(BASE));
    buildMcpServers({ baseConfig: BASE, extras: ['browser'], platform: 'linux', askUserBaseDir: '/x' });
    expect(BASE).toEqual(snapshot);
  });

  it('leaves args alone when no ask-user base dir is given', () => {
    const { config } = buildMcpServers({ baseConfig: BASE, platform: 'linux' });
    expect(config.mcpServers['ask-user'].args[0]).toBe('./ask-user.js');
  });
});
