import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// resolveAuth() drives three paths:
//   1. SIGNUPGENIUS_USER_KEY → Pro key mode (stateless v2/k surface)
//   2. SIGNUPGENIUS_EMAIL + SIGNUPGENIUS_PASSWORD → session-login (form POST → JWT + cookies)
//   3. fetchproxy fallback → @fetchproxy/bootstrap reads cookies from the user's
//      signed-in signupgenius.com tab and hydrates a session account
//   4. error: tell the user to set creds or sign into the browser
//
// These tests verify path selection, error shapes, and that we don't accidentally
// preempt env-var auth when it's set.

// Mock @fetchproxy/bootstrap at the module boundary — never hit a real WS.
const bootstrapMock = vi.fn();
vi.mock('@fetchproxy/bootstrap', () => ({
  bootstrap: (...args: unknown[]) => bootstrapMock(...args),
}));

import { resolveAuth } from '../src/auth.js';

const ENV_KEYS = [
  'SIGNUPGENIUS_USER_KEY',
  'SIGNUPGENIUS_EMAIL',
  'SIGNUPGENIUS_PASSWORD',
  'SIGNUPGENIUS_DISABLE_FETCHPROXY',
  'SIGNUPGENIUS_NAME',
  'SIGNUPGENIUS_BASE_URL',
  'SIGNUPGENIUS_LEGACY_BASE_URL',
  'SIGNUPGENIUS_LOGIN_URL',
] as const;

describe('resolveAuth', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    bootstrapMock.mockReset();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('path 1: SIGNUPGENIUS_USER_KEY (Pro key mode)', () => {
    it('returns a key-mode account when SIGNUPGENIUS_USER_KEY is set', async () => {
      process.env.SIGNUPGENIUS_USER_KEY = 'abc';
      const result = await resolveAuth();
      expect(result.account).toEqual({
        mode: 'key',
        name: 'api.signupgenius.com',
        baseUrl: 'https://api.signupgenius.com/v2/k',
        userKey: 'abc',
      });
      expect(result.source).toBe('env');
      expect(bootstrapMock).not.toHaveBeenCalled();
    });

    it('takes precedence even when EMAIL/PASSWORD are also set (existing behavior preserved)', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.env.SIGNUPGENIUS_USER_KEY = 'k';
      process.env.SIGNUPGENIUS_EMAIL = 'me@x.com';
      process.env.SIGNUPGENIUS_PASSWORD = 'pw';
      const result = await resolveAuth();
      expect(result.account.mode).toBe('key');
      expect(bootstrapMock).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('path 2: SIGNUPGENIUS_EMAIL + SIGNUPGENIUS_PASSWORD (session-login)', () => {
    it('returns a session-mode account when both creds are set', async () => {
      process.env.SIGNUPGENIUS_EMAIL = 'me@x.com';
      process.env.SIGNUPGENIUS_PASSWORD = 'pw';
      const result = await resolveAuth();
      expect(result.account).toMatchObject({
        mode: 'session',
        email: 'me@x.com',
        password: 'pw',
        baseUrl: 'https://api.signupgenius.com/v3',
        legacyBaseUrl: 'https://www.signupgenius.com',
        loginBaseUrl: 'https://www.signupgenius.com',
      });
      expect(result.source).toBe('env');
      expect(bootstrapMock).not.toHaveBeenCalled();
    });

    it('throws on partial session config (existing behavior preserved)', async () => {
      process.env.SIGNUPGENIUS_EMAIL = 'me@x.com';
      await expect(resolveAuth()).rejects.toThrow(/missing: SIGNUPGENIUS_PASSWORD/);
      expect(bootstrapMock).not.toHaveBeenCalled();
    });
  });

  describe('path 3: fetchproxy fallback', () => {
    it('reads cookies via bootstrap() when no env vars are set', async () => {
      bootstrapMock.mockResolvedValue({
        cookies: {
          accessToken: 'jwt-from-fp',
          cfid: 'fp-cfid',
          cftoken: 'fp-cftoken',
        },
        localStorage: {},
        sessionStorage: {},
        capturedHeaders: {},
      });

      const result = await resolveAuth();

      expect(bootstrapMock).toHaveBeenCalledTimes(1);
      const opts = bootstrapMock.mock.calls[0]![0] as {
        serverName: string;
        version: string;
        domains: string[];
        declare: {
          cookies: string[];
          localStorage: string[];
          sessionStorage: string[];
          captureHeaders: unknown[];
        };
      };
      expect(opts.serverName).toBe('signupgenius-mcp');
      expect(typeof opts.version).toBe('string');
      expect(opts.domains).toEqual(['signupgenius.com']);
      // Declare ALL cookies the MCP may need (the 0.3.0 read_cookies cap uses
      // chrome.cookies.get which exposes HttpOnly cookies — the security gate
      // is the declared key list).
      expect(opts.declare.cookies.sort()).toEqual(['MTOKEN', 'accessToken', 'cfid', 'cftoken']);
      expect(opts.declare.localStorage).toEqual([]);
      expect(opts.declare.sessionStorage).toEqual([]);
      expect(opts.declare.captureHeaders).toEqual([]);

      expect(result.source).toBe('fetchproxy');
      expect(result.account.mode).toBe('session');
      if (result.account.mode !== 'session') throw new Error('unreachable');
      expect(result.account.email).toBe(''); // no creds in fetchproxy mode
      expect(result.account.password).toBe('');
      expect(result.preloaded?.accessToken).toBe('jwt-from-fp');
      expect(result.preloaded?.cookieHeader).toContain('accessToken=jwt-from-fp');
      expect(result.preloaded?.cookieHeader).toContain('cfid=fp-cfid');
      expect(result.preloaded?.cookieHeader).toContain('cftoken=fp-cftoken');
    });

    it('accepts MTOKEN as an alias for accessToken (whichever the browser exposes first)', async () => {
      bootstrapMock.mockResolvedValue({
        cookies: {
          MTOKEN: 'jwt-via-mtoken',
          cfid: 'fp-cfid',
          cftoken: 'fp-cftoken',
        },
        localStorage: {},
        sessionStorage: {},
        capturedHeaders: {},
      });

      const result = await resolveAuth();
      expect(result.preloaded?.accessToken).toBe('jwt-via-mtoken');
    });

    it('prefers accessToken over MTOKEN when both are exposed', async () => {
      bootstrapMock.mockResolvedValue({
        cookies: {
          accessToken: 'tok-canonical',
          MTOKEN: 'tok-alias',
          cfid: 'fp-cfid',
          cftoken: 'fp-cftoken',
        },
        localStorage: {},
        sessionStorage: {},
        capturedHeaders: {},
      });

      const result = await resolveAuth();
      expect(result.preloaded?.accessToken).toBe('tok-canonical');
    });

    it('throws with an actionable message when the JWT cookie is missing', async () => {
      bootstrapMock.mockResolvedValue({
        cookies: { cfid: 'x', cftoken: 'y' },
        localStorage: {},
        sessionStorage: {},
        capturedHeaders: {},
      });
      await expect(resolveAuth()).rejects.toThrow(/sign into signupgenius\.com/i);
    });

    it('wraps bootstrap() errors with the same actionable suffix', async () => {
      bootstrapMock.mockRejectedValue(new Error('extension offline'));
      await expect(resolveAuth()).rejects.toThrow(/fetchproxy fallback failed: extension offline/);
    });

    it('handles non-Error rejections from bootstrap()', async () => {
      bootstrapMock.mockRejectedValue('plain string failure');
      await expect(resolveAuth()).rejects.toThrow(/fetchproxy fallback failed: plain string failure/);
    });

    it('surfaces FetchproxyBridgeDownError.hint verbatim when the SW retry exhausts', async () => {
      // 0.8.0+: bootstrap propagates FetchproxyBridgeDownError when the
      // server's lazy-revive retry also fails. We surface the typed
      // `.hint` so users see the actionable "click the extension toolbar
      // icon" message in path 3, matching the self-service guidance in
      // path 4.
      const { FetchproxyBridgeDownError } = await import('@fetchproxy/server');
      const downErr = new FetchproxyBridgeDownError({
        originalError: 'content_script_unreachable',
        retryAttempted: true,
        op: 'read_cookies',
      });
      bootstrapMock.mockRejectedValue(downErr);

      await expect(resolveAuth()).rejects.toThrow(/fetchproxy bridge is down/);
      await expect(resolveAuth()).rejects.toThrow(downErr.hint.slice(0, 20));
    });

    it('cfid/cftoken are optional — JWT alone is enough to hydrate a session', async () => {
      bootstrapMock.mockResolvedValue({
        cookies: { accessToken: 'just-the-jwt' },
        localStorage: {},
        sessionStorage: {},
        capturedHeaders: {},
      });
      const result = await resolveAuth();
      expect(result.preloaded?.accessToken).toBe('just-the-jwt');
      expect(result.preloaded?.cookieHeader).toBe('accessToken=just-the-jwt');
    });
  });

  describe('path 4: nothing configured', () => {
    it('skips fetchproxy when SIGNUPGENIUS_DISABLE_FETCHPROXY=1', async () => {
      process.env.SIGNUPGENIUS_DISABLE_FETCHPROXY = '1';
      await expect(resolveAuth()).rejects.toThrow(/SIGNUPGENIUS_USER_KEY/);
      await expect(resolveAuth()).rejects.toThrow(/SIGNUPGENIUS_EMAIL/);
      expect(bootstrapMock).not.toHaveBeenCalled();
    });

    it.each(['1', 'true', 'yes', 'on', 'TRUE'])(
      'treats SIGNUPGENIUS_DISABLE_FETCHPROXY=%j as disabled',
      async (val) => {
        process.env.SIGNUPGENIUS_DISABLE_FETCHPROXY = val;
        await expect(resolveAuth()).rejects.toThrow(/SIGNUPGENIUS_USER_KEY/);
        expect(bootstrapMock).not.toHaveBeenCalled();
      },
    );

    it.each(['0', 'false', 'no', '', 'off'])(
      'treats SIGNUPGENIUS_DISABLE_FETCHPROXY=%j as enabled (default)',
      async (val) => {
        process.env.SIGNUPGENIUS_DISABLE_FETCHPROXY = val;
        bootstrapMock.mockResolvedValue({
          cookies: { accessToken: 'tok' },
          localStorage: {},
          sessionStorage: {},
          capturedHeaders: {},
        });
        await resolveAuth();
        expect(bootstrapMock).toHaveBeenCalled();
      },
    );

    // Defends against MCP hosts that stringify undefined user_config refs
    // ("undefined", "null") or leave the literal placeholder intact
    // ("${user_config.foo}"). Same sanitization as config.ts's readVar().
    it.each(['undefined', 'null', '${SIGNUPGENIUS_DISABLE_FETCHPROXY}'])(
      'treats SIGNUPGENIUS_DISABLE_FETCHPROXY=%j as unset (= enabled)',
      async (val) => {
        process.env.SIGNUPGENIUS_DISABLE_FETCHPROXY = val;
        bootstrapMock.mockResolvedValue({
          cookies: { accessToken: 'tok' },
          localStorage: {},
          sessionStorage: {},
          capturedHeaders: {},
        });
        await resolveAuth();
        expect(bootstrapMock).toHaveBeenCalled();
      },
    );
  });

  describe('error propagation', () => {
    it('re-throws partial-session-config errors from loadAccount() instead of falling through', async () => {
      // EMAIL set without PASSWORD → loadAccount throws with the "missing:"
      // marker. That's a user mistake, NOT "no creds at all", so we must
      // propagate it — falling through to fetchproxy would mask the typo.
      process.env.SIGNUPGENIUS_EMAIL = 'me@x.com';
      await expect(resolveAuth()).rejects.toThrow(/missing: SIGNUPGENIUS_PASSWORD/);
      expect(bootstrapMock).not.toHaveBeenCalled();
    });

    it('re-throws non-https override errors from loadAccount() instead of falling through', async () => {
      process.env.SIGNUPGENIUS_USER_KEY = 'k';
      process.env.SIGNUPGENIUS_BASE_URL = 'http://insecure.example.com';
      await expect(resolveAuth()).rejects.toThrow(/must be an https URL/);
      expect(bootstrapMock).not.toHaveBeenCalled();
    });
  });
});
