import { describe, it, expect, vi } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import type { SignUpGeniusClient } from '../src/client.js';

interface Result {
  ok: boolean;
  credential: { source: string | null; detail?: Record<string, unknown> };
  error?: { kind: string; message: string };
  hint: string;
}

function clientWith(mode: 'session' | 'key', probe: (path: string) => Promise<unknown>) {
  return { mode, request: probe } as unknown as SignUpGeniusClient;
}

async function call(client: SignUpGeniusClient) {
  const h = await createTestHarness((server) => registerHealthcheckTools(server, client));
  const res = await h.client.callTool({ name: 'signupgenius_healthcheck', arguments: {} });
  await h.close?.();
  return parseToolResult<Result>(res as never);
}

describe('signupgenius_healthcheck', () => {
  // The two modes hit different API versions, so a tool 404ing because the
  // wrong mode is active looks nothing like an auth problem. Naming the mode
  // and the endpoint it implies is the point.
  it('names the mode and its endpoint in session mode', async () => {
    const r = await call(clientWith('session', async () => ({ id: 1 })));
    expect(r.ok).toBe(true);
    expect(r.credential.source).toBe('fetchproxy session');
    expect(r.credential.detail).toMatchObject({ mode: 'session', profile_endpoint: '/v3/member/profile' });
  });

  it('names the mode and its endpoint in key mode', async () => {
    const r = await call(clientWith('key', async () => ({ id: 1 })));
    expect(r.credential.source).toBe('api key');
    expect(r.credential.detail).toMatchObject({ mode: 'key', profile_endpoint: '/v2/k/user/profile' });
  });

  // A passing healthcheck must mean REAL tools work, so the probe has to
  // follow the same mode switch they do.
  it('probes the path the active mode actually uses', async () => {
    const session = vi.fn(async () => ({}));
    await call(clientWith('session', session));
    expect(session).toHaveBeenCalledWith('/member/profile');

    const key = vi.fn(async () => ({}));
    await call(clientWith('key', key));
    expect(key).toHaveBeenCalledWith('/user/profile');
  });

  it('tells a rejected credential apart from an upstream failure', async () => {
    const rejected = await call(
      clientWith('key', async () => {
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      }),
    );
    expect(rejected.error?.kind).toBe('credential_rejected');
    expect(rejected.hint).toMatch(/SIGNUPGENIUS_API_KEY/);

    const upstream = await call(
      clientWith('key', async () => {
        throw Object.assign(new Error('Bad gateway'), { status: 502 });
      }),
    );
    expect(upstream.error?.kind).toBe('http');
  });
});
