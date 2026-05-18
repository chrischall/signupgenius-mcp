import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadAccount } from '../src/config.js';

afterEach(() => vi.restoreAllMocks());

describe('loadAccount — key mode', () => {
  it('returns a KeyAccount for just a user key', () => {
    expect(loadAccount({ SIGNUPGENIUS_USER_KEY: 'abc' })).toEqual({
      mode: 'key',
      name: 'api.signupgenius.com',
      baseUrl: 'https://api.signupgenius.com/v2/k',
      userKey: 'abc',
    });
  });

  it('honors SIGNUPGENIUS_BASE_URL override and strips trailing slash', () => {
    const acct = loadAccount({ SIGNUPGENIUS_USER_KEY: 'k', SIGNUPGENIUS_BASE_URL: 'https://x.example.com/v2/k/' });
    expect(acct.baseUrl).toBe('https://x.example.com/v2/k');
    expect(acct.name).toBe('x.example.com');
  });

  it('honors SIGNUPGENIUS_NAME', () => {
    const acct = loadAccount({ SIGNUPGENIUS_USER_KEY: 'k', SIGNUPGENIUS_NAME: 'PTA Org' });
    expect(acct.name).toBe('PTA Org');
  });

  it('rejects non-https base URLs', () => {
    expect(() => loadAccount({ SIGNUPGENIUS_USER_KEY: 'k', SIGNUPGENIUS_BASE_URL: 'http://x' })).toThrow(
      /must be an https URL/,
    );
  });

  it('logs a warning when both key and full session creds are set, prefers key', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const acct = loadAccount({
      SIGNUPGENIUS_USER_KEY: 'k',
      SIGNUPGENIUS_EMAIL: 'me@x.com',
      SIGNUPGENIUS_PASSWORD: 'pw',
    });
    expect(acct.mode).toBe('key');
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/takes precedence over SIGNUPGENIUS_EMAIL/));
  });

  it('logs a different warning when key + partial session creds are set', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadAccount({ SIGNUPGENIUS_USER_KEY: 'k', SIGNUPGENIUS_EMAIL: 'me@x.com' });
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/Ignoring partial session credentials \(only EMAIL set\)/));
    spy.mockClear();
    loadAccount({ SIGNUPGENIUS_USER_KEY: 'k', SIGNUPGENIUS_PASSWORD: 'pw' });
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/PASSWORD set/));
  });
});

describe('loadAccount — session mode', () => {
  const baseEnv = { SIGNUPGENIUS_EMAIL: 'me@x.com', SIGNUPGENIUS_PASSWORD: 'pw' };

  it('returns a SessionAccount with default URLs', () => {
    expect(loadAccount(baseEnv)).toEqual({
      mode: 'session',
      name: 'me@x.com',
      baseUrl: 'https://api.signupgenius.com/v3',
      legacyBaseUrl: 'https://www.signupgenius.com',
      loginBaseUrl: 'https://www.signupgenius.com',
      email: 'me@x.com',
      password: 'pw',
    });
  });

  it('honors SIGNUPGENIUS_NAME', () => {
    expect(loadAccount({ ...baseEnv, SIGNUPGENIUS_NAME: 'Family' }).name).toBe('Family');
  });

  it('honors SIGNUPGENIUS_BASE_URL / LEGACY_BASE_URL / LOGIN_URL overrides', () => {
    const acct = loadAccount({
      ...baseEnv,
      SIGNUPGENIUS_BASE_URL: 'https://api.example.com/v3/',
      SIGNUPGENIUS_LEGACY_BASE_URL: 'https://web.example.com/',
      SIGNUPGENIUS_LOGIN_URL: 'https://login.example.com/',
    });
    expect(acct).toMatchObject({
      mode: 'session',
      baseUrl: 'https://api.example.com/v3',
      legacyBaseUrl: 'https://web.example.com',
      loginBaseUrl: 'https://login.example.com',
    });
  });

  it('rejects non-https overrides on each session URL', () => {
    for (const key of ['SIGNUPGENIUS_BASE_URL', 'SIGNUPGENIUS_LEGACY_BASE_URL', 'SIGNUPGENIUS_LOGIN_URL']) {
      expect(() => loadAccount({ ...baseEnv, [key]: 'http://x' })).toThrow(/must be an https URL/);
    }
  });

  it('throws on partial session config (email only)', () => {
    expect(() => loadAccount({ SIGNUPGENIUS_EMAIL: 'me@x.com' })).toThrow(
      /missing: SIGNUPGENIUS_PASSWORD/,
    );
  });

  it('throws on partial session config (password only)', () => {
    expect(() => loadAccount({ SIGNUPGENIUS_PASSWORD: 'pw' })).toThrow(
      /missing: SIGNUPGENIUS_EMAIL/,
    );
  });
});

describe('loadAccount — env sanitization', () => {
  // Values that hosts pass through when a config field isn't actually set:
  // empty/whitespace, the stringified word "undefined" (Claude Desktop's
  // serialization of an undefined user_config ref), "null", and unresolved
  // ${user_config.foo} placeholders (other hosts pass the literal string).
  const blanks = ['', '   ', 'undefined', 'null', '${user_config.signupgenius_user_key}'];

  it.each(blanks)('treats USER_KEY=%j as missing and falls through', (raw) => {
    expect(() => loadAccount({ SIGNUPGENIUS_USER_KEY: raw })).toThrow(/Missing SignUpGenius auth config/);
  });

  it.each(blanks)('treats EMAIL=%j as missing — partial session config triggers a specific error', (raw) => {
    // Pair the blank EMAIL with a real PASSWORD so we exercise the
    // partial-session error rather than the catch-all missing-config error.
    expect(() =>
      loadAccount({ SIGNUPGENIUS_EMAIL: raw, SIGNUPGENIUS_PASSWORD: 'pw' }),
    ).toThrow(/missing: SIGNUPGENIUS_EMAIL/);
  });

  it.each(blanks)('treats PASSWORD=%j as missing — partial session config triggers a specific error', (raw) => {
    expect(() =>
      loadAccount({ SIGNUPGENIUS_EMAIL: 'me@x.com', SIGNUPGENIUS_PASSWORD: raw }),
    ).toThrow(/missing: SIGNUPGENIUS_PASSWORD/);
  });

  it.each(blanks)('treats both EMAIL and PASSWORD blanks (%j) as fully absent', (raw) => {
    expect(() =>
      loadAccount({ SIGNUPGENIUS_EMAIL: raw, SIGNUPGENIUS_PASSWORD: raw }),
    ).toThrow(/Missing SignUpGenius auth config/);
  });

  it.each(blanks)('treats SIGNUPGENIUS_NAME=%j as unset — falls back to email/host default', (raw) => {
    const sessionAcct = loadAccount({
      SIGNUPGENIUS_EMAIL: 'me@x.com',
      SIGNUPGENIUS_PASSWORD: 'pw',
      SIGNUPGENIUS_NAME: raw,
    });
    expect(sessionAcct.name).toBe('me@x.com');

    const keyAcct = loadAccount({
      SIGNUPGENIUS_USER_KEY: 'k',
      SIGNUPGENIUS_NAME: raw,
    });
    expect(keyAcct.name).toBe('api.signupgenius.com');
  });

  it.each(blanks)('treats SIGNUPGENIUS_BASE_URL=%j as unset — falls back to per-mode default', (raw) => {
    const sessionAcct = loadAccount({
      SIGNUPGENIUS_EMAIL: 'me@x.com',
      SIGNUPGENIUS_PASSWORD: 'pw',
      SIGNUPGENIUS_BASE_URL: raw,
    });
    expect(sessionAcct.baseUrl).toBe('https://api.signupgenius.com/v3');

    const keyAcct = loadAccount({
      SIGNUPGENIUS_USER_KEY: 'k',
      SIGNUPGENIUS_BASE_URL: raw,
    });
    expect(keyAcct.baseUrl).toBe('https://api.signupgenius.com/v2/k');
  });

  it.each(blanks)('treats SIGNUPGENIUS_LEGACY_BASE_URL=%j and SIGNUPGENIUS_LOGIN_URL=%j as unset', (raw) => {
    const acct = loadAccount({
      SIGNUPGENIUS_EMAIL: 'me@x.com',
      SIGNUPGENIUS_PASSWORD: 'pw',
      SIGNUPGENIUS_LEGACY_BASE_URL: raw,
      SIGNUPGENIUS_LOGIN_URL: raw,
    });
    if (acct.mode !== 'session') throw new Error('expected session mode');
    expect(acct.legacyBaseUrl).toBe('https://www.signupgenius.com');
    expect(acct.loginBaseUrl).toBe('https://www.signupgenius.com');
  });

  it('throws a unified error when nothing is set', () => {
    expect(() => loadAccount({})).toThrow(/Missing SignUpGenius auth config/);
  });

  it('does NOT mistake a placeholder USER_KEY for credentials when EMAIL/PASSWORD are real', () => {
    // Common host-substitution failure mode: user filled in email/password in
    // the MCPB UI but left the optional Pro key blank. The host may still emit
    // SIGNUPGENIUS_USER_KEY="${user_config.signupgenius_user_key}". Session
    // mode must win.
    const acct = loadAccount({
      SIGNUPGENIUS_EMAIL: 'me@x.com',
      SIGNUPGENIUS_PASSWORD: 'pw',
      SIGNUPGENIUS_USER_KEY: '${user_config.signupgenius_user_key}',
    });
    expect(acct.mode).toBe('session');
  });

  it('does NOT mistake placeholder EMAIL/PASSWORD for credentials when USER_KEY is real', () => {
    const acct = loadAccount({
      SIGNUPGENIUS_USER_KEY: 'k',
      SIGNUPGENIUS_EMAIL: '${user_config.signupgenius_email}',
      SIGNUPGENIUS_PASSWORD: '${user_config.signupgenius_password}',
    });
    expect(acct.mode).toBe('key');
  });
});
