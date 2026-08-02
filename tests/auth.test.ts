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

  describe('path 3: fetchproxy fallback (lazy — bootstrap runs per login, not at startup)', () => {
    const okCookies = (cookies: Record<string, string>) => ({
      cookies,
      localStorage: {},
      sessionStorage: {},
      capturedHeaders: {},
    });

    it('does NOT bootstrap during resolveAuth — the browser is read lazily', async () => {
      // The whole point of the lazy refactor. bootstrap() used to run once at
      // process start; the JWT it captured has a 30-MINUTE TTL, so the
      // fetchproxy path died half an hour after every server start and could
      // not recover without a restart. Deferring the lift to login time means
      // each expiry re-reads the browser instead.
      bootstrapMock.mockResolvedValue(okCookies({ accessToken: 'tok' }));
      const result = await resolveAuth();
      expect(bootstrapMock).not.toHaveBeenCalled();
      expect(result.source).toBe('fetchproxy');
      expect(typeof result.refresh).toBe('function');
      expect(result.account.mode).toBe('session');
      if (result.account.mode !== 'session') throw new Error('unreachable');
      expect(result.account.email).toBe(''); // no creds in fetchproxy mode
      expect(result.account.password).toBe('');
    });

    it('refresh() lifts the declared cookies from the www host', async () => {
      bootstrapMock.mockResolvedValue(
        okCookies({ accessToken: 'jwt-from-fp', cfid: 'fp-cfid', cftoken: 'fp-cftoken' }),
      );

      const { refresh } = await resolveAuth();
      const session = await refresh!();

      expect(bootstrapMock).toHaveBeenCalledTimes(1);
      const opts = bootstrapMock.mock.calls[0]![0] as {
        serverName: string;
        version: string;
        domains: string[];
        storageSubdomain?: string;
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
      // Cookies MUST be read at the www host, not the apex. Verified against a
      // live signed-in browser: `https://signupgenius.com` exposes only
      // `accessToken`, while `https://www.signupgenius.com` exposes
      // `accessToken` + `cfid` + `cftoken`. Without the ColdFusion pair the
      // legacy /SUGboxAPI.cfm dispatcher answers 200 `{SUCCESS:false,
      // MESSAGE:["...You are no longer logged in..."]}` — so an apex-only lift
      // silently breaks every legacy-action tool.
      expect(opts.storageSubdomain).toBe('www');
      // Declare ALL cookies the MCP may need (the 0.3.0 read_cookies cap uses
      // chrome.cookies.get which exposes HttpOnly cookies — the security gate
      // is the declared key list).
      expect(opts.declare.cookies.sort()).toEqual([
        'MTOKEN',
        'accessToken',
        'cfid',
        'cftoken',
        'refreshToken',
      ]);
      expect(opts.declare.localStorage).toEqual([]);
      expect(opts.declare.sessionStorage).toEqual([]);
      expect(opts.declare.captureHeaders).toEqual([]);

      expect(session.accessToken).toBe('jwt-from-fp');
      expect(session.cookieHeader).toContain('accessToken=jwt-from-fp');
      expect(session.cookieHeader).toContain('cfid=fp-cfid');
      expect(session.cookieHeader).toContain('cftoken=fp-cftoken');
    });

    it('re-reads the browser on every refresh() — a new token each expiry', async () => {
      bootstrapMock
        .mockResolvedValueOnce(okCookies({ accessToken: 'tok-1' }))
        .mockResolvedValueOnce(okCookies({ accessToken: 'tok-2' }));
      const { refresh } = await resolveAuth();
      expect((await refresh!()).accessToken).toBe('tok-1');
      expect((await refresh!()).accessToken).toBe('tok-2');
      expect(bootstrapMock).toHaveBeenCalledTimes(2);
    });

    it('accepts MTOKEN as an alias for accessToken (whichever the browser exposes first)', async () => {
      bootstrapMock.mockResolvedValue(
        okCookies({ MTOKEN: 'jwt-via-mtoken', cfid: 'fp-cfid', cftoken: 'fp-cftoken' }),
      );
      const { refresh } = await resolveAuth();
      expect((await refresh!()).accessToken).toBe('jwt-via-mtoken');
    });

    it('prefers accessToken over MTOKEN when both are exposed', async () => {
      bootstrapMock.mockResolvedValue(
        okCookies({ accessToken: 'tok-canonical', MTOKEN: 'tok-alias' }),
      );
      const { refresh } = await resolveAuth();
      expect((await refresh!()).accessToken).toBe('tok-canonical');
    });

    it('throws with an actionable message when the JWT cookie is missing', async () => {
      bootstrapMock.mockResolvedValue(okCookies({ cfid: 'x', cftoken: 'y' }));
      const { refresh } = await resolveAuth();
      await expect(refresh!()).rejects.toThrow(/sign into signupgenius\.com/i);
    });

    it('tells the user to retry — which now works, because the lift is lazy', async () => {
      // Inverse of the pre-refactor behavior. With a per-login bootstrap the
      // user can sign in and simply re-run the tool; no restart is needed, so
      // the message must NOT send them off to restart the server.
      bootstrapMock.mockResolvedValue(okCookies({ cfid: 'x', cftoken: 'y' }));
      const { refresh } = await resolveAuth();
      const err = await refresh!().then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message).toMatch(/retry/i);
      expect(err?.message).not.toMatch(/restart/i);
    });

    it('wraps bootstrap() errors with the same actionable suffix', async () => {
      bootstrapMock.mockRejectedValue(new Error('extension offline'));
      const { refresh } = await resolveAuth();
      await expect(refresh!()).rejects.toThrow(/fetchproxy lift failed: extension offline/);
    });

    it('handles non-Error rejections from bootstrap()', async () => {
      bootstrapMock.mockRejectedValue('plain string failure');
      const { refresh } = await resolveAuth();
      await expect(refresh!()).rejects.toThrow(/fetchproxy lift failed: plain string failure/);
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
      const { refresh } = await resolveAuth();
      await expect(refresh!()).rejects.toThrow(/fetchproxy bridge is down/);
      await expect(refresh!()).rejects.toThrow(downErr.hint);
    });

    // ── Token renewal ──────────────────────────────────────────────────────
    //
    // The cookie in the browser is only as fresh as the last time the SPA
    // renewed it: an IDLE tab can hold a JWT that expired minutes ago
    // (observed live — a lift returned a token 7 minutes past exp). Re-reading
    // cookies alone therefore does NOT survive the 30-minute TTL; the
    // refreshToken has to be exchanged for a new access token.
    const makeJwt = (expSecondsFromNow: number) => {
      const b64 = (o: unknown) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
    };

    it('uses the lifted token as-is when it still has life left', async () => {
      bootstrapMock.mockResolvedValue(
        okCookies({ accessToken: makeJwt(1800), refreshToken: 'rt-uuid' }),
      );
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const { refresh } = await resolveAuth();
      await refresh!();
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('exchanges an EXPIRED lifted token for a fresh one via /v3/auth/refresh', async () => {
      const stale = makeJwt(-420); // 7 minutes past exp, as seen live
      const fresh = makeJwt(1800);
      bootstrapMock.mockResolvedValue(
        okCookies({ accessToken: stale, refreshToken: 'rt-uuid', cfid: 'c', cftoken: '0' }),
      );
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: { statuscode: 200, response: { token: fresh, refreshtoken: 'rt-2' } },
          }),
          { status: 200 },
        ) as unknown as Response,
      );

      const { refresh } = await resolveAuth();
      const session = await refresh!();

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.signupgenius.com/v3/auth/refresh');
      expect(init.method).toBe('POST');
      // BOTH fields are required — the live endpoint 400s on refreshToken alone
      // with "token should not be null or undefined".
      expect(JSON.parse(init.body as string)).toEqual({
        refreshToken: 'rt-uuid',
        token: stale,
      });
      expect(session.accessToken).toBe(fresh);
      expect(session.cookieHeader).toContain(`accessToken=${fresh}`);
      expect(session.cookieHeader).toContain('cfid=c');
      fetchSpy.mockRestore();
    });

    it('renews a token that is within the skew window but not yet expired', async () => {
      const fresh = makeJwt(1800);
      bootstrapMock.mockResolvedValue(
        okCookies({ accessToken: makeJwt(30), refreshToken: 'rt' }),
      );
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: { response: { token: fresh } } }),
          { status: 200 },
        ) as unknown as Response,
      );
      const { refresh } = await resolveAuth();
      expect((await refresh!()).accessToken).toBe(fresh);
      fetchSpy.mockRestore();
    });

    it('treats an undecodable/opaque token as usable rather than guessing', async () => {
      bootstrapMock.mockResolvedValue(okCookies({ accessToken: 'not-a-jwt' }));
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const { refresh } = await resolveAuth();
      expect((await refresh!()).accessToken).toBe('not-a-jwt');
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('treats a JWT with a non-numeric exp as opaque', async () => {
      const weird = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
        JSON.stringify({ exp: 'soon' }),
      ).toString('base64url')}.sig`;
      bootstrapMock.mockResolvedValue(okCookies({ accessToken: weird }));
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const { refresh } = await resolveAuth();
      expect((await refresh!()).accessToken).toBe(weird);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('treats a JWT whose payload is not valid JSON as opaque', async () => {
      bootstrapMock.mockResolvedValue(okCookies({ accessToken: 'aaa.bbb.ccc' }));
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const { refresh } = await resolveAuth();
      expect((await refresh!()).accessToken).toBe('aaa.bbb.ccc');
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('explains what to do when the token is stale and no refreshToken exists', async () => {
      bootstrapMock.mockResolvedValue(okCookies({ accessToken: makeJwt(-60) }));
      const { refresh } = await resolveAuth();
      await expect(refresh!()).rejects.toThrow(/expired.*no refreshToken cookie/is);
    });

    it('surfaces an actionable error when the refresh exchange is rejected', async () => {
      bootstrapMock.mockResolvedValue(
        okCookies({ accessToken: makeJwt(-60), refreshToken: 'rt' }),
      );
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ success: false, message: [] }), {
          status: 400,
        }) as unknown as Response,
      );
      const { refresh } = await resolveAuth();
      await expect(refresh!()).rejects.toThrow(/token refresh failed \(HTTP 400\)/);
      fetchSpy.mockRestore();
    });

    it('surfaces an error when the refresh response omits the new token', async () => {
      bootstrapMock.mockResolvedValue(
        okCookies({ accessToken: makeJwt(-60), refreshToken: 'rt' }),
      );
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
        }) as unknown as Response,
      );
      const { refresh } = await resolveAuth();
      await expect(refresh!()).rejects.toThrow(/token refresh failed/);
      fetchSpy.mockRestore();
    });

    it('surfaces an error when the refresh response is not JSON', async () => {
      bootstrapMock.mockResolvedValue(
        okCookies({ accessToken: makeJwt(-60), refreshToken: 'rt' }),
      );
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('<html>', { status: 200 }) as unknown as Response);
      const { refresh } = await resolveAuth();
      await expect(refresh!()).rejects.toThrow(/token refresh failed/);
      fetchSpy.mockRestore();
    });

    it('cfid/cftoken are optional — JWT alone is enough to hydrate a session', async () => {
      bootstrapMock.mockResolvedValue(okCookies({ accessToken: 'just-the-jwt' }));
      const { refresh } = await resolveAuth();
      const session = await refresh!();
      expect(session.accessToken).toBe('just-the-jwt');
      expect(session.cookieHeader).toBe('accessToken=just-the-jwt');
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
        const result = await resolveAuth();
        expect(result.source).toBe('fetchproxy');
        expect(typeof result.refresh).toBe('function');
      },
    );

    // Defends against MCP hosts that stringify undefined user_config refs
    // ("undefined", "null") or leave the literal placeholder intact
    // ("${user_config.foo}"). Same sanitization as config.ts's readVar().
    it.each(['undefined', 'null', '${SIGNUPGENIUS_DISABLE_FETCHPROXY}'])(
      'treats SIGNUPGENIUS_DISABLE_FETCHPROXY=%j as unset (= enabled)',
      async (val) => {
        process.env.SIGNUPGENIUS_DISABLE_FETCHPROXY = val;
        const result = await resolveAuth();
        expect(result.source).toBe('fetchproxy');
        expect(typeof result.refresh).toBe('function');
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
