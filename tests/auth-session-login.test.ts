import { describe, it, expect, vi, afterEach } from 'vitest';
import { sessionLogin, LoginFailedError } from '../src/auth-session-login.js';

afterEach(() => vi.restoreAllMocks());

/**
 * Builds a Response that exposes getSetCookie() returning multiple values —
 * mirrors how undici reports Set-Cookie from a real SUG response.
 */
function htmlResponseWithCookies(
  body: string,
  status: number,
  setCookies: string[],
  location?: string,
): Response {
  const headers = new Headers({ 'Content-Type': 'text/html' });
  for (const c of setCookies) headers.append('set-cookie', c);
  if (location) headers.set('location', location);
  const res = new Response(body, { status, headers });
  // Older mocks may not have getSetCookie — patch it to return the array.
  (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie = () => setCookies;
  return res;
}

function fakeLoginPageHtml(token = 'csrf-abc123'): string {
  return `<form><input type="hidden" name="csrfToken" value="${token}" required="true" /></form>`;
}

describe('sessionLogin', () => {
  it('scrapes csrfToken from the login page, POSTs credentials, and extracts accessToken', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/login')) {
        return htmlResponseWithCookies(fakeLoginPageHtml('csrf-real'), 200, [
          'cfid=abc; Path=/; Secure; HttpOnly',
          'cftoken=0; Path=/; Secure; HttpOnly',
        ]);
      }
      // POST to c.Login
      expect(u).toContain('go=c.Login');
      const body = (init?.body as string) ?? '';
      expect(body).toContain('csrfToken=csrf-real');
      expect(body).toContain('loginemail=me%40x.com');
      expect(body).toContain('pword=secret');
      return htmlResponseWithCookies('', 302, [
        'accessToken=jwt-token; Domain=signupgenius.com; Path=/; HttpOnly; Secure',
        'refreshToken=refresh-uuid; Domain=signupgenius.com; Path=/; HttpOnly; Secure',
      ], '/index.cfm?go=c.MyAccount');
    });

    const result = await sessionLogin({ email: 'me@x.com', password: 'secret' });
    expect(result.accessToken).toBe('jwt-token');
    expect(result.cookieHeader).toContain('cfid=abc');
    expect(result.cookieHeader).toContain('cftoken=0');
    expect(result.cookieHeader).toContain('accessToken=jwt-token');
    expect(result.cookieHeader).toContain('refreshToken=refresh-uuid');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('honors a custom loginUrl override', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      expect(u.startsWith('https://staging.example.com')).toBe(true);
      if (u.endsWith('/login')) {
        return htmlResponseWithCookies(fakeLoginPageHtml(), 200, []);
      }
      return htmlResponseWithCookies('', 302, ['accessToken=jwt; Path=/'], '/index.cfm?go=c.MyAccount');
    });
    const result = await sessionLogin({
      loginUrl: 'https://staging.example.com',
      email: 'me@x.com',
      password: 'pw',
    });
    expect(result.accessToken).toBe('jwt');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws when the login page returns a non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 503 }) as unknown as Response,
    );
    await expect(sessionLogin({ email: 'a', password: 'b' })).rejects.toBeInstanceOf(LoginFailedError);
    await expect(sessionLogin({ email: 'a', password: 'b' })).rejects.toThrow(/login page returned 503/);
  });

  it('throws when csrfToken cannot be found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      htmlResponseWithCookies('<html>no token</html>', 200, []),
    );
    await expect(sessionLogin({ email: 'a', password: 'b' })).rejects.toThrow(/csrfToken not found/);
  });

  it('detects credential failure when server redirects to c.Register', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/login')) {
        return htmlResponseWithCookies(fakeLoginPageHtml(), 200, []);
      }
      return htmlResponseWithCookies('', 302, [], '/index.cfm?go=c.Register');
    });
    await expect(sessionLogin({ email: 'a', password: 'wrong' })).rejects.toThrow(
      /rejected the credentials/,
    );
  });

  it('throws a generic error when neither accessToken nor c.Register show up', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/login')) {
        return htmlResponseWithCookies(fakeLoginPageHtml(), 200, []);
      }
      return htmlResponseWithCookies('', 200, []);
    });
    await expect(sessionLogin({ email: 'a', password: 'b' })).rejects.toThrow(
      /did not yield an accessToken/,
    );
  });

  /** Shadow Headers.getSetCookie with an own undefined property to force the legacy fallback. */
  function withoutGetSetCookie(res: Response): Response {
    Object.defineProperty(res.headers, 'getSetCookie', { value: undefined, configurable: true });
    return res;
  }

  it('falls back to splitting headers.get("set-cookie") when getSetCookie is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/login')) {
        const headers = new Headers();
        // Single concatenated set-cookie string, as some legacy runtimes return.
        // The splitter must NOT cut on commas inside `Expires=Wed, 17 Jun ...`
        // and MUST cut before the second cookie's `name=`.
        headers.append(
          'set-cookie',
          'cfid=legacy; Path=/; Expires=Wed, 17 Jun 2026 15:00:00 GMT, csrf=skip; Path=/',
        );
        return withoutGetSetCookie(new Response(fakeLoginPageHtml('csrf-legacy'), { status: 200, headers }));
      }
      const headers = new Headers();
      headers.append('set-cookie', 'accessToken=legacy-jwt; Path=/');
      return withoutGetSetCookie(new Response('', { status: 302, headers }));
    });

    const result = await sessionLogin({ email: 'a', password: 'b' });
    expect(result.accessToken).toBe('legacy-jwt');
    expect(result.cookieHeader).toContain('cfid=legacy');
    expect(result.cookieHeader).toContain('csrf=skip');
  });

  it('handles a response with no set-cookie header via the legacy fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/login')) {
        return withoutGetSetCookie(new Response(fakeLoginPageHtml(), { status: 200 }));
      }
      const headers = new Headers();
      headers.append('set-cookie', 'accessToken=t; Path=/');
      return withoutGetSetCookie(new Response('', { status: 302, headers }));
    });
    const result = await sessionLogin({ email: 'a', password: 'b' });
    expect(result.accessToken).toBe('t');
  });

  it('ignores malformed set-cookie pairs that lack name= or have a whitespace-only name', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/login')) {
        return htmlResponseWithCookies(fakeLoginPageHtml(), 200, [
          'novalue', // no `=`
          '=novalueeither', // `=` at position 0 → caught by eq<=0 guard
          ' =wsname', // `=` not at 0, but the chars before trim to empty
          'good=1',
        ]);
      }
      return htmlResponseWithCookies('', 302, ['accessToken=jwt; Path=/']);
    });
    const result = await sessionLogin({ email: 'a', password: 'b' });
    expect(result.cookieHeader).toContain('good=1');
    expect(result.cookieHeader).toContain('accessToken=jwt');
    expect(result.cookieHeader).not.toContain('novalue');
    expect(result.cookieHeader).not.toContain('wsname');
  });
});
