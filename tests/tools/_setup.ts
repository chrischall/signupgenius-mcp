import { vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SignUpGeniusClient } from '../../src/client.js';
import type { KeyAccount, SessionAccount } from '../../src/config.js';

export type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

export const keyAccount: KeyAccount = {
  mode: 'key',
  name: 'sug',
  baseUrl: 'https://api.signupgenius.com/v2/k',
  userKey: 'KEY',
};

export const sessionAccount: SessionAccount = {
  mode: 'session',
  name: 'me@x.com',
  baseUrl: 'https://api.signupgenius.com/v3',
  legacyBaseUrl: 'https://www.signupgenius.com',
  loginBaseUrl: 'https://www.signupgenius.com',
  email: 'me@x.com',
  password: 'pw',
};

export function setupTools(
  register: (server: McpServer, client: SignUpGeniusClient) => void,
  account: KeyAccount | SessionAccount = keyAccount,
  responseFor: ((path: string, opts: unknown) => unknown) | unknown = { ok: true },
) {
  const client = new SignUpGeniusClient(account);
  const requestSpy = vi
    .spyOn(client, 'request')
    .mockImplementation(async (path: string, opts?: unknown) => {
      if (typeof responseFor === 'function') {
        return (responseFor as (p: string, o: unknown) => unknown)(path, opts) as never;
      }
      return responseFor as never;
    });
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const handlers = new Map<string, Handler>();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _c: unknown, cb: unknown) => {
    handlers.set(name, cb as Handler);
    return undefined as never;
  });
  register(server, client);
  return { client, handlers, requestSpy };
}
