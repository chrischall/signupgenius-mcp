import { describe, it, expect, vi, afterEach } from 'vitest';
import { SignUpGeniusClient, AuthError, UnreachableError, ModeMismatchError } from '../src/client.js';
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

  it('throws AuthError on 403', async () => {
    mockFetch({ status: 403, body: { data: null, message: ['bad key'], success: false } });
    const client = new SignUpGeniusClient(keyAccount);
    await expect(client.request('/x')).rejects.toBeInstanceOf(AuthError);
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

  it('throws UnreachableError on 5xx', async () => {
    mockFetch({ status: 502, rawBody: '' });
    const client = new SignUpGeniusClient(keyAccount);
    await expect(client.request('/x')).rejects.toBeInstanceOf(UnreachableError);
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

describe('ModeMismatchError messaging', () => {
  it('directs to user_key when key mode is required', () => {
    const err = new ModeMismatchError('session', 'key', 'Pro reports');
    expect(err.message).toMatch(/Set SIGNUPGENIUS_USER_KEY/);
  });

  it('directs to email/password when session mode is required', () => {
    const err = new ModeMismatchError('key', 'session', 'Add group member');
    expect(err.message).toMatch(/Set SIGNUPGENIUS_EMAIL \+ SIGNUPGENIUS_PASSWORD/);
  });
});
