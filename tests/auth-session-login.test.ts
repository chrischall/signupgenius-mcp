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
      expect(init?.method).toBe('POST');
      const body = (init?.body as string) ?? '';
      expect(body).toContain('csrfToken=csrf-real');
      expect(body).toContain('loginemail=me%40x.com');
      expect(body).toContain('pword=secret');
      // SUG-specific static form fields must survive the swap to the shared flow.
      expect(body).toContain('failpage=c.Register');
      expect(body).toContain('formName=loginform');
      // The login page's cookies ride along on the credential POST.
      const cookie = new Headers(init?.headers as HeadersInit).get('cookie') ?? '';
      expect(cookie).toContain('cfid=abc');
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
    await expect(sessionLogin({ email: 'a', password: 'b' })).rejects.toThrow(/login page returned 503/i);
  });

  it('throws when csrfToken cannot be found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      htmlResponseWithCookies('<html>no token</html>', 200, []),
    );
    await expect(sessionLogin({ email: 'a', password: 'b' })).rejects.toThrow(
      /csrf token not found/i,
    );
  });

  it('detects credential failure when server redirects to c.Register', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/login')) {
        return htmlResponseWithCookies(fakeLoginPageHtml(), 200, []);
      }
      return htmlResponseWithCookies('', 302, [], '/index.cfm?go=c.Register');
    });
    await expect(sessionLogin({ email: 'a', password: 'wrong' })).rejects.toBeInstanceOf(
      LoginFailedError,
    );
    await expect(sessionLogin({ email: 'a', password: 'wrong' })).rejects.toThrow(
      /login form rejected the credentials/,
    );
  });

  it('throws a generic error when neither accessToken nor c.Register show up', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/login')) {
        return htmlResponseWithCookies(fakeLoginPageHtml(), 200, []);
      }
      return htmlResponseWithCookies('', 200, []);
    });
    await expect(sessionLogin({ email: 'a', password: 'b' })).rejects.toBeInstanceOf(
      LoginFailedError,
    );
    await expect(sessionLogin({ email: 'a', password: 'b' })).rejects.toThrow(
      /did not yield a[n]? accessToken/,
    );
    // Must NOT be misclassified as a credential rejection.
    await expect(sessionLogin({ email: 'a', password: 'b' })).rejects.not.toThrow(
      /login form rejected the credentials/,
    );
  });

  it('wraps non-Error throws from fetch in LoginFailedError', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'socket exploded';
    });
    await expect(sessionLogin({ email: 'a', password: 'b' })).rejects.toBeInstanceOf(
      LoginFailedError,
    );
    await expect(sessionLogin({ email: 'a', password: 'b' })).rejects.toThrow(/socket exploded/);
  });

  it('drops deletion-marker cookies from the merged cookie header (shared-jar upgrade)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/login')) {
        return htmlResponseWithCookies(fakeLoginPageHtml(), 200, [
          'cfid=abc; Path=/',
          'stale=old-value; Path=/; Max-Age=0',
        ]);
      }
      return htmlResponseWithCookies('', 302, [
        'accessToken=jwt; Path=/',
        'gone=deleted; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      ], '/index.cfm?go=c.MyAccount');
    });
    const result = await sessionLogin({ email: 'a', password: 'b' });
    expect(result.accessToken).toBe('jwt');
    expect(result.cookieHeader).toContain('cfid=abc');
    expect(result.cookieHeader).not.toContain('stale=');
    expect(result.cookieHeader).not.toContain('gone=');
  });
});
