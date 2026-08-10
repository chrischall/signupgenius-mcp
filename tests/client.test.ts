import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpToolError } from '@chrischall/mcp-utils';
import {
  SignUpGeniusClient,
  AuthError,
  UnreachableError,
  ModeMismatchError,
  KeyModeRequiredError,
} from '../src/client.js';
import type { KeyAccount, SessionAccount } from '../src/config.js';

const keyAccount: KeyAccount = {
  mode: 'key',
  name: 'sug',
  baseUrl: 'https://api.signupgenius.com/v2/k',
  userKey: 'KEY',
};

const sessionAccount: SessionAccount = {
  mode: 'session',
  name: 'me@x.com',
  baseUrl: 'https://api.signupgenius.com/v3',
  legacyBaseUrl: 'https://www.signupgenius.com',
  loginBaseUrl: 'https://www.signupgenius.com',
  email: 'me@x.com',
  password: 'pw',
};

function mockFetch(...responses: Array<{ status?: number; body?: unknown; rawBody?: string }>) {
  let i = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    const body = r.rawBody ?? (r.body !== undefined ? JSON.stringify(r.body) : '');
    return new Response(body, { status: r.status ?? 200 }) as unknown as Response;
  });
}

const ok = (data: unknown) => ({ body: { data, message: [], success: true } });
const okLegacy = (data: unknown) => ({ body: { DATA: data, MESSAGE: [], SUCCESS: true, CODE: '' } });

afterEach(() => vi.restoreAllMocks());

describe('SignUpGeniusClient — key mode', () => {
  it('appends user_key and a trailing slash, parses lowercase envelope', async () => {
    const fetchSpy = mockFetch(ok({ hi: 1 }));
    const client = new SignUpGeniusClient(keyAccount);
    const result = await client.request<{ hi: number }>('/user/profile');
    expect(result.data).toEqual({ hi: 1 });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toBe('https://api.signupgenius.com/v2/k/user/profile/?user_key=KEY');
  });

  it('preserves explicit trailing slash, merges query params, skips undefined entries', async () => {
    const fetchSpy = mockFetch(ok([]));
    const client = new SignUpGeniusClient(keyAccount);
    await client.request('/groups/', { query: { sort: 'asc', skipMe: undefined, n: 5, flag: true } });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url.startsWith('https://api.signupgenius.com/v2/k/groups/?')).toBe(true);
    expect(url).toContain('user_key=KEY');
    expect(url).toContain('sort=asc');
    expect(url).toContain('n=5');
    expect(url).toContain('flag=true');
    expect(url).not.toContain('skipMe');
  });

  it('POSTs a JSON body with Content-Type header', async () => {
    const fetchSpy = mockFetch(ok({}));
    const client = new SignUpGeniusClient(keyAccount);
    await client.request('/groups/1/members/create/', { method: 'POST', body: { emailaddress: 'a@b.com' } });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ emailaddress: 'a@b.com' }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('throws AuthError on 403 (an McpToolError carrying the key/session guidance as hint)', async () => {
    mockFetch({ status: 403, body: { data: null, message: ['bad key'], success: false } });
    const client = new SignUpGeniusClient(keyAccount);
    const err = await client.request('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as AuthError).status).toBe(403);
    expect((err as AuthError).hint).toMatch(/check SIGNUPGENIUS_USER_KEY/);
    expect((err as AuthError).hint).toMatch(/session cookie may have been invalidated/);
  });

  it('AuthError omits the optional upstream-message suffix when no message is provided', async () => {
    mockFetch({ status: 403, rawBody: '' });
    const client = new SignUpGeniusClient(keyAccount);
    // When upstream returns no message, the trailing ` (detail)` suffix is absent;
    // the static body of the error always ends after the "invalidated server-side." sentence.
    await expect(client.request('/x')).rejects.toThrowError(/invalidated server-side\.$/);
  });

  it('AuthError appends the upstream message when one is provided', async () => {
    mockFetch({ status: 403, body: { data: null, message: ['bad key', 'try again'], success: false } });
    const client = new SignUpGeniusClient(keyAccount);
    await expect(client.request('/x')).rejects.toThrow(/\(bad key; try again\)$/);
  });

  it('throws a 404 error', async () => {
    mockFetch({ status: 404, rawBody: '' });
    const client = new SignUpGeniusClient(keyAccount);
    await expect(client.request('/missing')).rejects.toThrow(/SignUpGenius 404 \/missing/);
  });

  it('throws UnreachableError on 5xx (shared template: names the service, carries the status)', async () => {
    mockFetch({ status: 502, rawBody: '' });
    const client = new SignUpGeniusClient(keyAccount);
    const err = await client.request('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnreachableError);
    expect((err as UnreachableError).status).toBe(502);
    expect((err as UnreachableError).message).toMatch(/SignUpGenius unreachable \(status 502\)/);
  });

  it('throws on a generic 4xx with message', async () => {
    mockFetch({ status: 418, body: { data: null, message: ['teapot'], success: false } });
    const client = new SignUpGeniusClient(keyAccount);
    await expect(client.request('/x')).rejects.toThrow(/SignUpGenius 418 teapot/);
  });

  it('uses statusText for non-special errors with no message field', async () => {
    mockFetch({ status: 400, rawBody: '' });
    const client = new SignUpGeniusClient(keyAccount);
    await expect(client.request('/x')).rejects.toThrow(/SignUpGenius 400 /);
  });

  it('throws "empty body" when body is empty on a 2xx', async () => {
    mockFetch({ status: 200, rawBody: '' });
    const client = new SignUpGeniusClient(keyAccount);
    await expect(client.request('/x')).rejects.toThrow(/empty body for \/x/);
  });

  it('throws "non-JSON body" when body is non-JSON text on a 2xx', async () => {
    mockFetch({ status: 200, rawBody: '<html>oops</html>' });
    const client = new SignUpGeniusClient(keyAccount);
    await expect(client.request('/x')).rejects.toThrow(/non-JSON body for \/x/);
  });

  it.each([
    ['JSON number', '42'],
    ['JSON string', '"hello"'],
    ['JSON true', 'true'],
    ['JSON zero (falsy)', '0'],
  ])('rejects %s top-level primitive bodies (normalizer guard)', async (_label, rawBody) => {
    mockFetch({ status: 200, rawBody });
    const client = new SignUpGeniusClient(keyAccount);
    await expect(client.request('/x')).rejects.toThrow(/non-JSON body for \/x/);
  });

  it("throws when success:false on a 2xx", async () => {
    mockFetch({ status: 200, body: { data: null, message: ['bad'], success: false } });
    const client = new SignUpGeniusClient(keyAccount);
    await expect(client.request('/x')).rejects.toThrow(/SignUpGenius error: bad/);
  });

  it('falls back to "unknown" when success:false has no message', async () => {
    mockFetch({ status: 200, body: { data: null, success: false } });
    const client = new SignUpGeniusClient(keyAccount);
    await expect(client.request('/x')).rejects.toThrow(/SignUpGenius error: unknown/);
  });

  it('treats a missing success field as success:false (normalizer guard)', async () => {
    // Exercises the `r.success ?? false` branch in normalizeKeyShape.
    mockFetch({ status: 200, body: { data: 'whatever' } });
    const client = new SignUpGeniusClient(keyAccount);
    await expect(client.request('/x')).rejects.toThrow(/SignUpGenius error: unknown/);
  });

  it('describe() reports mode + baseUrl, no secrets', () => {
    const client = new SignUpGeniusClient(keyAccount);
    expect(client.describe()).toEqual({ name: 'sug', mode: 'key', baseUrl: 'https://api.signupgenius.com/v2/k' });
    expect(client.mode).toBe('key');
  });
});

describe('SignUpGeniusClient — session mode', () => {
  const fakeLogin = vi.fn(async () => ({ accessToken: 'jwt-1', cookieHeader: 'a=b' }));
  const newClient = () => new SignUpGeniusClient(sessionAccount, { sessionLogin: fakeLogin });

  afterEach(() => fakeLogin.mockClear());

  it('logs in lazily, hits v3 with Bearer + Cookie, no user_key', async () => {
    const fetchSpy = mockFetch(ok({ id: 1 }));
    const client = newClient();
    await client.request('/member/profile');
    expect(fakeLogin).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toBe('https://api.signupgenius.com/v3/member/profile/');
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-1');
    expect(headers.Cookie).toBe('a=b');
  });

  it('reuses the cached session on subsequent calls', async () => {
    mockFetch(ok({}), ok({}));
    const client = newClient();
    await client.request('/member/profile');
    await client.request('/groups/');
    expect(fakeLogin).toHaveBeenCalledOnce();
  });

  it('re-logins exactly once on a 401, then retries the same request', async () => {
    const fetchSpy = mockFetch(
      { status: 401, rawBody: '' },
      ok({ ok: true }),
    );
    fakeLogin
      .mockImplementationOnce(async () => ({ accessToken: 'jwt-1', cookieHeader: 'a=b' }))
      .mockImplementationOnce(async () => ({ accessToken: 'jwt-2', cookieHeader: 'a=c' }));
    const client = newClient();
    const result = await client.request<{ ok: boolean }>('/member/profile');
    expect(result.data).toEqual({ ok: true });
    expect(fakeLogin).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const retryHeaders = (fetchSpy.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer jwt-2');
  });

  it('surfaces a persistent 401 (login succeeded but token immediately invalid) as AuthError', async () => {
    mockFetch({ status: 401, rawBody: '' }, { status: 401, rawBody: '' });
    const client = newClient();
    await expect(client.request('/x')).rejects.toBeInstanceOf(AuthError);
    await expect(client.request('/x')).rejects.toThrow(/rejected the request \(401\)/);
  });

  it('serializes concurrent first-call logins (no thundering herd)', async () => {
    mockFetch(ok({}), ok({}));
    const client = newClient();
    let resolveLogin: (() => void) | null = null;
    fakeLogin.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveLogin = () => res({ accessToken: 'jwt-1', cookieHeader: 'a=b' });
        }),
    );
    const p1 = client.request('/a');
    const p2 = client.request('/b');
    // Both should be waiting on the same login promise — resolve once
    resolveLogin!();
    await Promise.all([p1, p2]);
    expect(fakeLogin).toHaveBeenCalledOnce();
  });

  it('routes legacyAction calls to /SUGboxAPI.cfm and unwraps the uppercase envelope', async () => {
    const fetchSpy = mockFetch(okLegacy({ signups: [{ id: 1 }] }));
    const client = newClient();
    const result = await client.request<{ signups: Array<{ id: number }> }>('', { legacyAction: 't.getMySignups' });
    expect(result).toEqual({ data: { signups: [{ id: 1 }] }, message: [], success: true });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toBe('https://www.signupgenius.com/SUGboxAPI.cfm?go=t.getMySignups');
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
  });

  it('forwards the request body on legacy POST and normalizes scalar MESSAGE to array', async () => {
    const fetchSpy = mockFetch({ body: { DATA: null, MESSAGE: 'all good', SUCCESS: true } });
    const client = newClient();
    const result = await client.request('', { legacyAction: 't.foo', body: { listid: 42 } });
    expect(result.message).toEqual(['all good']);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ listid: 42 }));
  });

  it('legacy: an empty scalar MESSAGE is normalized to an empty array', async () => {
    mockFetch({ body: { DATA: 1, MESSAGE: '', SUCCESS: true } });
    const client = newClient();
    const result = await client.request('', { legacyAction: 't.x' });
    expect(result.message).toEqual([]);
  });

  it('legacy: SUCCESS:false bubbles up as a SignUpGenius error', async () => {
    mockFetch({ body: { DATA: '', MESSAGE: ['nope'], SUCCESS: false, CODE: 9999 } });
    const client = newClient();
    await expect(client.request('', { legacyAction: 't.x' })).rejects.toThrow(/SignUpGenius error: nope/);
  });

  it('legacy: SUCCESS:false with scalar empty MESSAGE falls back to "unknown"', async () => {
    mockFetch({ body: { DATA: '', MESSAGE: '', SUCCESS: false } });
    const client = newClient();
    await expect(client.request('', { legacyAction: 't.x' })).rejects.toThrow(/SignUpGenius error: unknown/);
  });

  it('legacy: SUCCESS:false with no MESSAGE field at all falls back to "unknown"', async () => {
    // Exercises the `?? ''` nullish-coalescing branch in parseLegacyEnvelope.
    mockFetch({ body: { DATA: '', SUCCESS: false } });
    const client = newClient();
    await expect(client.request('', { legacyAction: 't.x' })).rejects.toThrow(/SignUpGenius error: unknown/);
  });

  it('legacy: 403 maps to AuthError', async () => {
    mockFetch({ status: 403, rawBody: '' });
    const client = newClient();
    await expect(client.request('', { legacyAction: 't.x' })).rejects.toBeInstanceOf(AuthError);
  });

  it('legacy: 5xx maps to UnreachableError', async () => {
    mockFetch({ status: 503, rawBody: '' });
    const client = newClient();
    await expect(client.request('', { legacyAction: 't.x' })).rejects.toBeInstanceOf(UnreachableError);
  });

  it('legacy: other non-2xx surfaces statusText', async () => {
    mockFetch({ status: 400, rawBody: '' });
    const client = newClient();
    await expect(client.request('', { legacyAction: 't.x' })).rejects.toThrow(/SignUpGenius 400 /);
  });

  it('legacy: non-JSON body throws cleanly', async () => {
    mockFetch({ status: 200, rawBody: '<html>oh no</html>' });
    const client = newClient();
    await expect(client.request('', { legacyAction: 't.x' })).rejects.toThrow(/non-JSON body for t.x/);
  });

  it.each([
    ['JSON number', '42'],
    ['JSON falsy zero', '0'],
  ])('legacy: rejects %s top-level primitive bodies (normalizer guard)', async (_label, rawBody) => {
    mockFetch({ status: 200, rawBody });
    const client = newClient();
    await expect(client.request('', { legacyAction: 't.x' })).rejects.toThrow(/non-JSON body for t.x/);
  });

  it('legacy: SUCCESS missing entirely defaults to false (treated as error)', async () => {
    // Exercises the `r.SUCCESS ?? false` branch in normalizeLegacyShape.
    mockFetch({ body: { DATA: '', MESSAGE: ['nope'] } });
    const client = newClient();
    await expect(client.request('', { legacyAction: 't.x' })).rejects.toThrow(/SignUpGenius error: nope/);
  });

  it('requireMode throws ModeMismatchError when the wrong mode is active', () => {
    const client = newClient();
    expect(() => client.requireMode('key', 'Pro reports')).toThrowError(ModeMismatchError);
    // No throw when the mode matches:
    expect(() => client.requireMode('session', 'anything')).not.toThrow();
  });

  it('describe() reports session mode and the v3 base URL', () => {
    const client = newClient();
    expect(client.describe()).toEqual({ name: 'me@x.com', mode: 'session', baseUrl: 'https://api.signupgenius.com/v3' });
  });
});

describe('SignUpGeniusClient — session expiry detection (status + 200 legacy-HTML login page)', () => {
  const fakeLogin = vi.fn(async () => ({ accessToken: 'jwt-1', cookieHeader: 'a=b' }));
  const newClient = () => new SignUpGeniusClient(sessionAccount, { sessionLogin: fakeLogin });
  afterEach(() => fakeLogin.mockClear());

  // A 200 that renders the legacy HTML login page (instead of JSON) means the
  // ColdFusion session lapsed. mockFetch can't set headers, so build the
  // Responses by hand: an html-typed login page, then a normal JSON success.
  const LOGIN_PAGE =
    '<!doctype html><html><body><form name="loginform">' +
    '<input name="loginemail"></form></body></html>';

  function mockResponses(...responses: Response[]) {
    let i = 0;
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const r = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return r as unknown as Response;
    });
  }

  it('treats a 200 legacy-HTML login page as expiry: re-logs-in and replays once', async () => {
    const fetchSpy = mockResponses(
      new Response(LOGIN_PAGE, { status: 200, headers: { 'content-type': 'text/html' } }),
      new Response(JSON.stringify({ data: { ok: true }, message: [], success: true }), { status: 200 }),
    );
    fakeLogin
      .mockImplementationOnce(async () => ({ accessToken: 'jwt-1', cookieHeader: 'a=b' }))
      .mockImplementationOnce(async () => ({ accessToken: 'jwt-2', cookieHeader: 'a=c' }));
    const client = newClient();
    const result = await client.request<{ ok: boolean }>('/member/profile');
    expect(result.data).toEqual({ ok: true });
    expect(fakeLogin).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const retryHeaders = (fetchSpy.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer jwt-2');
  });

  it('detects the login page even when the response carries no content-type', async () => {
    // A header-less 200 must still be body-sniffed (the `if (ct && !looksHtml)`
    // early-out only fires when a non-html content-type is present).
    const headerless = new Response(LOGIN_PAGE, { status: 200 });
    headerless.headers.delete('content-type');
    const fetchSpy = mockResponses(
      headerless,
      new Response(JSON.stringify({ data: 1, message: [], success: true }), { status: 200 }),
    );
    const client = newClient();
    const result = await client.request('/x');
    expect(result.data).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // The legacy /SUGboxAPI.cfm dispatcher has a THIRD expiry shape that neither
  // the 401 nor the HTML-login-page check catches: a 200 with a well-formed
  // JSON envelope whose SUCCESS is false and whose MESSAGE says the session is
  // gone. Observed live when the ColdFusion cfid/cftoken pair is absent or
  // stale — the JWT alone is not enough for this dispatcher.
  const LOGGED_OUT_JSON = JSON.stringify({
    SUCCESS: false,
    MESSAGE: [
      'There was a problem executing this page. You are no longer logged in. Please login and attempt again.',
    ],
    DATA: {},
  });

  it('treats a 200 JSON "no longer logged in" envelope as expiry: re-logs-in and replays', async () => {
    const fetchSpy = mockResponses(
      new Response(LOGGED_OUT_JSON, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(JSON.stringify({ DATA: { signups: [] }, MESSAGE: [], SUCCESS: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = newClient();
    const result = await client.request('', { legacyAction: 't.getMySignups' });
    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fakeLogin).toHaveBeenCalledTimes(2);
  });

  it('does NOT treat an ordinary JSON SUCCESS:false as expiry (no re-login)', async () => {
    // Only the "no longer logged in" wording is an expiry signal. Every other
    // dispatcher error must surface as-is, or a genuine application error would
    // burn a pointless re-login and mask itself.
    mockResponses(
      new Response(
        JSON.stringify({ SUCCESS: false, MESSAGE: ['Invalid Request'], DATA: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = newClient();
    await expect(client.request('', { legacyAction: 's.getSignUpFormItems' })).rejects.toThrow(
      /Invalid Request/,
    );
    expect(fakeLogin).toHaveBeenCalledTimes(1);
  });

  it('does NOT treat an unrelated html 200 as expiry — surfaces a parse error, no re-login', async () => {
    mockResponses(
      new Response('<html><body>maintenance</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const client = newClient();
    await expect(client.request('/x')).rejects.toThrow(/non-JSON body for \/x/);
    expect(fakeLogin).toHaveBeenCalledOnce();
  });

  it('does NOT treat a 403 as session expiry (Pro-permission failure, not a lapsed session)', async () => {
    // 403 must surface as AuthError without a re-login attempt.
    mockResponses(new Response('', { status: 403 }));
    const client = newClient();
    await expect(client.request('/x')).rejects.toBeInstanceOf(AuthError);
    expect(fakeLogin).toHaveBeenCalledOnce();
  });
});

describe('SignUpGeniusClient — fetchproxy session (lazy lift + renewal)', () => {
  // The fetchproxy auth path hands the client a `refreshSession` function and
  // a session account with empty email/password. The client should (a) not
  // call it until the first request, (b) attach what it returns to every
  // request, and (c) call it AGAIN on expiry — the renewal that keeps the path
  // alive past the JWT's 30-minute TTL.
  const fakeLogin = vi.fn();
  const fpAccount: SessionAccount = { ...sessionAccount, email: '', password: '' };

  afterEach(() => fakeLogin.mockClear());

  it('does not lift the browser session until the first request', async () => {
    const refreshSession = vi.fn(async () => ({
      accessToken: 'jwt-from-browser',
      cookieHeader: 'accessToken=jwt-from-browser',
    }));
    const fetchSpy = mockFetch(ok({ ok: true }));
    const client = new SignUpGeniusClient(fpAccount, { sessionLogin: fakeLogin, refreshSession });
    expect(refreshSession).not.toHaveBeenCalled();
    await client.request('/anything');
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fakeLogin).not.toHaveBeenCalled();
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-from-browser');
  });

  it('attaches the lifted cookie header verbatim (cfid/cftoken included)', async () => {
    const refreshSession = vi.fn(async () => ({
      accessToken: 'jwt-from-browser',
      cookieHeader: 'accessToken=jwt-from-browser; cfid=x; cftoken=y',
    }));
    const fetchSpy = mockFetch(ok({ ok: true }));
    const client = new SignUpGeniusClient(fpAccount, { sessionLogin: fakeLogin, refreshSession });
    await client.request('/anything');
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Cookie).toBe('accessToken=jwt-from-browser; cfid=x; cftoken=y');
  });

  // THE fix for the 30-minute cliff. Previously the browser session was
  // captured once at startup and a 401 surfaced verbatim, because there were
  // no credentials to re-login with. Now expiry re-reads the browser, which
  // has a live session, and the request is replayed with the fresh JWT.
  it('re-lifts the browser session on a 401 and replays the request once', async () => {
    const refreshSession = vi
      .fn<() => Promise<{ accessToken: string; cookieHeader: string }>>()
      .mockResolvedValueOnce({ accessToken: 'stale-jwt', cookieHeader: 'accessToken=stale-jwt' })
      .mockResolvedValueOnce({ accessToken: 'fresh-jwt', cookieHeader: 'accessToken=fresh-jwt' });
    const fetchSpy = mockFetch({ status: 401, rawBody: '' }, ok({ ok: true }));
    const client = new SignUpGeniusClient(fpAccount, { sessionLogin: fakeLogin, refreshSession });
    const result = await client.request<{ ok: boolean }>('/x');
    expect(result.data).toEqual({ ok: true });
    expect(refreshSession).toHaveBeenCalledTimes(2);
    const retryHeaders = (fetchSpy.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer fresh-jwt');
    expect(fakeLogin).not.toHaveBeenCalled();
  });

  it('re-lifts on the legacy 200 "no longer logged in" envelope too', async () => {
    const refreshSession = vi
      .fn<() => Promise<{ accessToken: string; cookieHeader: string }>>()
      .mockResolvedValue({ accessToken: 'jwt', cookieHeader: 'accessToken=jwt' });
    mockFetch(
      {
        status: 200,
        rawBody: JSON.stringify({
          SUCCESS: false,
          MESSAGE: ['There was a problem executing this page. You are no longer logged in.'],
          DATA: {},
        }),
      },
      okLegacy({ signups: [] }),
    );
    const client = new SignUpGeniusClient(fpAccount, { sessionLogin: fakeLogin, refreshSession });
    const result = await client.request('', { legacyAction: 't.getMySignups' });
    expect(result.success).toBe(true);
    expect(refreshSession).toHaveBeenCalledTimes(2);
  });

  it('gives up after ONE renewal — a persistently dead browser session does not loop', async () => {
    const refreshSession = vi
      .fn<() => Promise<{ accessToken: string; cookieHeader: string }>>()
      .mockResolvedValue({ accessToken: 'still-dead', cookieHeader: 'accessToken=still-dead' });
    mockFetch({ status: 401, rawBody: '' });
    const client = new SignUpGeniusClient(fpAccount, { sessionLogin: fakeLogin, refreshSession });
    await expect(client.request('/x')).rejects.toBeInstanceOf(AuthError);
    expect(refreshSession).toHaveBeenCalledTimes(2);
  });

  it('surfaces a lift failure (signed out / extension down) as the tool error', async () => {
    const refreshSession = vi
      .fn<() => Promise<{ accessToken: string; cookieHeader: string }>>()
      .mockRejectedValue(new Error('accessToken cookie missing on www.signupgenius.com. …retry.'));
    mockFetch(ok({ ok: true }));
    const client = new SignUpGeniusClient(fpAccount, { sessionLogin: fakeLogin, refreshSession });
    await expect(client.request('/x')).rejects.toThrow(/accessToken cookie missing/);
  });

  it('without a refreshSession and without credentials, a 401 does not loop', async () => {
    mockFetch({ status: 401, rawBody: '' });
    const client = new SignUpGeniusClient(fpAccount, { sessionLogin: fakeLogin });
    await expect(client.request('/x')).rejects.toBeInstanceOf(AuthError);
    expect(fakeLogin).not.toHaveBeenCalled();
  });
});

describe('SignUpGeniusClient.deletePerson (slot release)', () => {
  // Release is a plain GET navigation in the wizard, not a SUGboxAPI JSON
  // action — the server answers with HTML and a redirect back to the sheet.
  it('GETs s.DeletePerson with id/imid/mid and no JSON Accept', async () => {
    const spy = mockFetch({ status: 302, rawBody: '' });
    const client = new SignUpGeniusClient(sessionAccount, { sessionLogin: async () => ({ accessToken: 'JWT', cookieHeader: 'cfid=1' }) });
    await client.deletePerson(62393618, 1381103237, 4262737);
    const url = spy.mock.calls[0]![0] as string;
    expect(url).toContain('/index.cfm?go=s.DeletePerson');
    expect(url).toContain('id=62393618');
    expect(url).toContain('imid=1381103237');
    expect(url).toContain('mid=4262737');
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>).Accept).toBe('text/html');
  });

  it('accepts a 200 as success', async () => {
    mockFetch({ status: 200, rawBody: '<html>ok</html>' });
    const client = new SignUpGeniusClient(sessionAccount, { sessionLogin: async () => ({ accessToken: 'JWT', cookieHeader: 'cfid=1' }) });
    await expect(client.deletePerson(1, 2, 3)).resolves.toBeUndefined();
  });

  it('treats a 302 to the login page as failure, not success', async () => {
    // redirect:'manual' hands the 302 back verbatim, so a bare `status >= 400`
    // check would report a lapsed CF session as a completed withdrawal.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 302, headers: { location: '/index.cfm?go=c.Login' } }) as never,
    );
    const client = new SignUpGeniusClient(sessionAccount, { sessionLogin: async () => ({ accessToken: 'JWT', cookieHeader: 'cfid=1' }) });
    await expect(client.deletePerson(62393618, 999, 4262737)).rejects.toBeInstanceOf(AuthError);
  });

  it('accepts a 302 back to the sheet', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 302, headers: { location: '/go/ABC-1' } }) as never,
    );
    const client = new SignUpGeniusClient(sessionAccount, { sessionLogin: async () => ({ accessToken: 'JWT', cookieHeader: 'cfid=1' }) });
    await expect(client.deletePerson(1, 2, 3)).resolves.toBeUndefined();
  });

  it('throws an actionable error on a 4xx/5xx', async () => {
    mockFetch({ status: 403, rawBody: '' });
    const client = new SignUpGeniusClient(sessionAccount, { sessionLogin: async () => ({ accessToken: 'JWT', cookieHeader: 'cfid=1' }) });
    await expect(client.deletePerson(62393618, 999, 4262737)).rejects.toThrow(
      /Releasing slot entry 999 .* status 403/,
    );
  });

  it('refuses in key mode', async () => {
    const client = new SignUpGeniusClient(keyAccount);
    await expect(client.deletePerson(1, 2, 3)).rejects.toBeInstanceOf(ModeMismatchError);
  });
});

describe('SignUpGeniusClient — degraded mode (no account configured)', () => {
  const bootstrapError = new Error('Missing SignUpGenius auth config. Set …');
  const newDegradedClient = () => new SignUpGeniusClient(null, { configError: bootstrapError });

  it('describe() reports the config error instead of account metadata', () => {
    const client = newDegradedClient();
    expect(client.describe()).toEqual({ error: bootstrapError.message });
  });

  it('describe() returns a generic message when no configError was provided', () => {
    const client = new SignUpGeniusClient(null);
    expect(client.describe()).toEqual({ error: 'no account configured' });
  });

  it('mode defaults to "session" so registration-time logic still picks the recommended set', () => {
    const client = newDegradedClient();
    expect(client.mode).toBe('session');
  });

  it('request() throws the stored configError on any tool call', async () => {
    const client = newDegradedClient();
    await expect(client.request('/anything')).rejects.toThrow(bootstrapError.message);
  });

  it('request() throws a generic "not configured" error when no configError was provided', async () => {
    const client = new SignUpGeniusClient(null);
    await expect(client.request('/anything')).rejects.toThrow(/is not configured/);
  });

  it('requireMode throws the stored configError', () => {
    const client = newDegradedClient();
    expect(() => client.requireMode('key', 'Pro reports')).toThrowError(bootstrapError.message);
  });

  // requireMode() calls requireAccount() first, so in degraded mode the
  // configError wins — and that error's remediation ("sign into
  // signupgenius.com in your browser") can NEVER enable a key-only feature.
  // requireKeyMode() leads with the requirement that actually applies.
  it('requireKeyMode leads with the Pro-key requirement, not the browser sign-in advice', () => {
    const client = newDegradedClient();
    const err = (() => {
      try {
        client.requireKeyMode('signupgenius_report_all');
        return null;
      } catch (e) {
        return e as KeyModeRequiredError;
      }
    })();
    expect(err).toBeInstanceOf(KeyModeRequiredError);
    expect(err!.message).toMatch(/requires Pro key mode/);
    expect(err!.message).toMatch(/SIGNUPGENIUS_USER_KEY/);
    expect(err!.hint).toMatch(/cannot enable this/i);
    // The underlying config error stays visible — it may itself be a
    // key-mode misconfiguration (e.g. a bad SIGNUPGENIUS_BASE_URL).
    expect(err!.message).toContain(bootstrapError.message);
  });

  it('requireKeyMode omits the config-error suffix when none was stored', () => {
    const client = new SignUpGeniusClient(null);
    expect(() => client.requireKeyMode('signupgenius_report_all')).toThrowError(
      /requires Pro key mode/,
    );
    try {
      client.requireKeyMode('signupgenius_report_all');
    } catch (e) {
      expect((e as Error).message).not.toMatch(/auth is also unconfigured/);
    }
  });
});

describe('requireKeyMode with a resolved account', () => {
  it('passes through in key mode', () => {
    const client = new SignUpGeniusClient({
      mode: 'key',
      name: 'k',
      baseUrl: 'https://api.signupgenius.com/v2/k',
      userKey: 'abc',
    });
    expect(() => client.requireKeyMode('signupgenius_report_all')).not.toThrow();
  });

  it('throws KeyModeRequiredError in session mode, naming both modes', () => {
    const client = new SignUpGeniusClient({
      mode: 'session',
      name: 's',
      baseUrl: 'https://api.signupgenius.com/v3',
      legacyBaseUrl: 'https://www.signupgenius.com',
      loginBaseUrl: 'https://www.signupgenius.com',
      email: 'a@b.c',
      password: 'pw',
    });
    // Deliberately NOT the shared ModeMismatchError: "switch to key mode"
    // does not tell the user that key mode means a paid Pro key, nor that
    // reports are owner-scoped and so cannot serve someone else's sheet.
    expect(() => client.requireKeyMode('signupgenius_report_all')).toThrowError(
      KeyModeRequiredError,
    );
    expect(() => client.requireKeyMode('signupgenius_report_all')).toThrowError(
      /requires Pro key mode but the server is running in session mode/,
    );
    expect(() => client.requireKeyMode('signupgenius_report_all')).toThrowError(
      /signupgenius_list_slots/,
    );
  });
});

describe('ModeMismatchError messaging (shared mcp-utils template)', () => {
  it('names the feature and both modes when key mode is required', () => {
    const err = new ModeMismatchError('session', 'key', 'Pro reports');
    expect(err.message).toMatch(/Pro reports requires key mode but the server is running in session mode/);
    expect(err.hint).toBe('Switch to key mode to use Pro reports.');
  });

  it('carries the modes and feature as readonly fields', () => {
    const err = new ModeMismatchError('key', 'session', 'Add group member');
    expect(err.currentMode).toBe('key');
    expect(err.requiredMode).toBe('session');
    expect(err.feature).toBe('Add group member');
    expect(err.message).toMatch(/requires session mode but the server is running in key mode/);
  });
});

describe('isSessionExpired — legacy-only body sniffing', () => {
  // The "no longer logged in" envelope comes ONLY from /SUGboxAPI.cfm. Applying
  // the phrase check (and its clone().text()) to every 200 meant v3 GETs and
  // write POSTs paid for a shape that cannot occur there.
  const fakeLogin = vi.fn(async () => ({ accessToken: 'jwt', cookieHeader: 'a=b' }));
  afterEach(() => fakeLogin.mockClear());

  it('does not treat a v3 response containing the phrase as expiry', async () => {
    // Contrived, but it proves the gate: user-authored sign-up content could
    // contain anything, and a v3 body must never be scanned for it.
    const spy = mockFetch({
      status: 200,
      rawBody: JSON.stringify({
        data: { description: 'Note: you are no longer logged in to the old system.' },
        message: [],
        success: true,
      }),
    });
    const client = new SignUpGeniusClient(sessionAccount, { sessionLogin: fakeLogin });
    const out = await client.request<{ description: string }>('/signups/created');
    expect(out.success).toBe(true);
    // One fetch, one login — no expiry replay was triggered.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fakeLogin).toHaveBeenCalledTimes(1);
  });
});
