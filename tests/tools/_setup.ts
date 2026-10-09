import { vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { SignUpGeniusClient } from '../../src/client.js';
import { confirmWrite } from '../../src/tools/_shared.js';
import type { KeyAccount, SessionAccount } from '../../src/config.js';

export type Handler = (
  args: Record<string, unknown>,
  ctx?: unknown,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

const CAPS = 'io.modelcontextprotocol/clientCapabilities';

/**
 * A caller that declares it cannot show an elicitation prompt (claude.ai, most
 * hosted clients). Gated writes answer it with the confirm-token flow: phase 1
 * returns a preview + confirmToken, phase 2 repeats the call with the token.
 */
export const TOKEN_CTX = { mcpReq: { envelope: { [CAPS]: {} } } };

/** A caller that CAN be prompted, on its first round (no answer yet). */
export const ELICIT_CTX = { mcpReq: { envelope: { [CAPS]: { elicitation: { form: {} } } } } };

/**
 * A caller that was prompted and accepted — the write may proceed in one call.
 * Since mcp-utils 3.0 an acceptance only counts alongside the HMAC-protected
 * `requestState` the prompt carried (bound to the action, account and
 * arguments), so the handlers built here ({@link wrapHandler}) swap this
 * marker for an accepted ctx that echoes a state minted for exactly that call,
 * as a conforming client would. Passed straight to a raw tool callback it
 * carries no state and is refused.
 */
export const ACCEPT_CTX = {
  mcpReq: {
    envelope: { [CAPS]: { elicitation: { form: {} } } },
    inputResponses: { confirmation: { action: 'accept', content: { confirmed: true } } },
  },
};

/** Each gated tool's confirmation action id — the state binds it. */
const ACTIONS: Record<string, string> = {
  signupgenius_add_group_member: 'signupgenius.group.add_member',
  signupgenius_claim_slot: 'signupgenius.claim_slot',
  signupgenius_release_slot: 'signupgenius.release_slot',
  signupgenius_rsvp: 'signupgenius.rsvp',
};

/**
 * The accepted round of an elicitation for `tool` called with `args` by
 * `client`'s account: the state comes from a real prompt round through the
 * same gate, so it binds exactly what the tool's own gate will check.
 */
export async function acceptedCtx(
  client: SignUpGeniusClient,
  tool: string,
  args: Record<string, unknown>,
) {
  const ask = (await confirmWrite(ELICIT_CTX as never, client, {
    tool,
    action: ACTIONS[tool] ?? tool,
    message: 'Confirm.',
    confirmationLabel: 'Confirm.',
    target: 'test',
    payload: {},
    preview: {},
    args,
  })) as unknown as { requestState?: unknown };
  if (typeof ask.requestState !== 'string') {
    throw new Error(`prompt round returned no requestState: ${JSON.stringify(ask)}`);
  }
  const state = ask.requestState;
  return { mcpReq: { ...ACCEPT_CTX.mcpReq, requestState: () => state } };
}

/**
 * A registered tool callback as tests call it: the ctx defaults to a
 * no-elicitation caller (the common hosted case), and {@link ACCEPT_CTX}
 * becomes a properly state-bound accepted round.
 */
export function wrapHandler(name: string, cb: unknown, client: SignUpGeniusClient): Handler {
  return async (args, ctx = TOKEN_CTX) =>
    (cb as Handler)(args, ctx === ACCEPT_CTX ? await acceptedCtx(client, name, args) : ctx);
}

/** A caller that was prompted and declined. */
export const DECLINE_CTX = {
  mcpReq: {
    envelope: { [CAPS]: { elicitation: { form: {} } } },
    inputResponses: { confirmation: { action: 'decline' } },
  },
};

/** Parse a tool result's first text block. */
export function parseText(res: unknown): Record<string, any> {
  return JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
}

/**
 * Run the full two-phase confirm-token flow for a no-elicitation caller:
 * phase 1 (no token) must dispatch nothing and return a token, phase 2 repeats
 * the SAME arguments plus that token.
 */
export async function confirmViaToken(handler: Handler, args: Record<string, unknown>) {
  const phase1 = parseText(await handler(args, TOKEN_CTX));
  if (typeof phase1.confirmToken !== 'string') {
    throw new Error(`phase 1 returned no confirmToken: ${JSON.stringify(phase1)}`);
  }
  return handler({ ...args, confirmToken: phase1.confirmToken }, TOKEN_CTX);
}

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
    handlers.set(name, wrapHandler(name, cb, client));
    return undefined as never;
  });
  register(server, client);
  return { client, handlers, requestSpy };
}
