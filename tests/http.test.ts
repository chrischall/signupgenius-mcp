import { describe, it, expect, vi, afterEach } from 'vitest';
import { withCallSignal } from '@chrischall/mcp-utils';
import { timedFetch, REQUEST_TIMEOUT_MS } from '../src/http.js';
import { SignUpGeniusClient } from '../src/client.js';
import type { KeyAccount, SessionAccount } from '../src/config.js';

// fleet-audit#701: no upstream fetch may hang a tool call indefinitely. Each
// one is bounded by a timeout and follows the MCP request's cancellation.

afterEach(() => vi.restoreAllMocks());

const okJson = () =>
  new Response(JSON.stringify({ data: 1, message: [], success: true }), { status: 200 });

describe('timedFetch', () => {
  it('attaches a timeout signal of REQUEST_TIMEOUT_MS', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson());
    await timedFetch('https://x.test/', { method: 'GET' });
    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    expect((spy.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect((spy.mock.calls[0]![1] as RequestInit).method).toBe('GET');
  });

  it('works with no init at all', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson());
    await timedFetch('https://x.test/');
    expect((spy.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps a caller-supplied signal', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson());
    const own = new AbortController().signal;
    await timedFetch('https://x.test/', { signal: own });
    expect((spy.mock.calls[0]![1] as RequestInit).signal).toBe(own);
  });

  it('aborts when the MCP request is cancelled', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson());
    const call = new AbortController();
    await withCallSignal(call.signal, () => timedFetch('https://x.test/'));
    const signal = (spy.mock.calls[0]![1] as RequestInit).signal!;
    expect(signal.aborted).toBe(false);
    call.abort(new Error('cancelled'));
    expect(signal.aborted).toBe(true);
  });
});

describe('SignUpGeniusClient — every upstream call is bounded', () => {
  const key: KeyAccount = { mode: 'key', name: 'k', baseUrl: 'https://api.signupgenius.com/v2/k', userKey: 'K' };
  const session: SessionAccount = {
    mode: 'session',
    name: 'me',
    baseUrl: 'https://api.signupgenius.com/v3',
    legacyBaseUrl: 'https://www.signupgenius.com',
    loginBaseUrl: 'https://www.signupgenius.com',
    email: 'me@x.com',
    password: 'pw',
  };
  const login = async () => ({ accessToken: 'jwt', cookieHeader: 'a=b' });
  const signalOf = (spy: ReturnType<typeof vi.spyOn>) =>
    (spy.mock.calls[0]![1] as RequestInit).signal;

  it('key-mode requests', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson());
    await new SignUpGeniusClient(key).request('/user/profile');
    expect(signalOf(spy)).toBeInstanceOf(AbortSignal);
  });

  it('session-mode requests', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson());
    await new SignUpGeniusClient(session, { sessionLogin: login }).request('/member/profile');
    expect(signalOf(spy)).toBeInstanceOf(AbortSignal);
  });

  it('PreProcessSignup', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 302 }));
    await new SignUpGeniusClient(session, { sessionLogin: login }).preProcessSignUp('ABC');
    expect(signalOf(spy)).toBeInstanceOf(AbortSignal);
  });

  it('DeletePerson', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 302 }));
    await new SignUpGeniusClient(session, { sessionLogin: login }).deletePerson(1, 2, 3);
    expect(signalOf(spy)).toBeInstanceOf(AbortSignal);
  });
});
