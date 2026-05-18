import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SignUpGeniusClient } from '../client.js';
import { textContent } from './_shared.js';

/**
 * Sign-up listing tools.
 *
 * v2/k exposes separate /active and /expired endpoints; v3 returns the full
 * list from a single /signups/created endpoint and expects the caller to
 * filter on enddate. We register the same tool names in both modes so a
 * downstream prompt can stay mode-agnostic.
 */

interface Listing {
  name: string;
  /** v3 path (session mode). */
  session: string;
  /** v2/k path (key mode). */
  key: string;
  desc: { key: string; session: string };
}

const LISTINGS: Listing[] = [
  {
    name: 'signupgenius_list_created_active',
    session: '/signups/created',
    key: '/signups/created/active',
    desc: {
      key: 'List ACTIVE sign-ups created by the API key holder.',
      session:
        'List sign-ups created by the authenticated user. In session mode this returns the full list (active + expired) — filter on enddate client-side if you need only active.',
    },
  },
  {
    name: 'signupgenius_list_created_expired',
    session: '/signups/created',
    key: '/signups/created/expired',
    desc: {
      key: 'List EXPIRED sign-ups created by the API key holder.',
      session:
        'Alias of signupgenius_list_created_active in session mode (v3 returns active + expired together). Filter on enddate client-side.',
    },
  },
  {
    name: 'signupgenius_list_created_all',
    session: '/signups/created',
    key: '/signups/created/all',
    desc: {
      key: 'List ALL sign-ups created by the API key holder (active and expired).',
      session: 'List ALL sign-ups created by the authenticated user (active and expired).',
    },
  },
  {
    name: 'signupgenius_list_invited',
    session: '/signups/invited',
    key: '/signups/invited/active',
    desc: {
      key: 'List sign-ups the user has been invited to. Not applicable to sub-admin credentials.',
      session: 'List sign-ups the user has been invited to.',
    },
  },
  {
    name: 'signupgenius_list_signedupfor',
    session: '/signups/signedupfor',
    key: '/signups/signedupfor/active',
    desc: {
      key: 'List sign-ups the user has personally signed up for. Not applicable to sub-admin credentials.',
      session: 'List sign-ups the user has personally signed up for.',
    },
  },
];

export function registerSignUpTools(server: McpServer, client: SignUpGeniusClient): void {
  const session = client.mode === 'session';

  for (const l of LISTINGS) {
    server.registerTool(
      l.name,
      { description: session ? l.desc.session : l.desc.key, annotations: { readOnlyHint: true } },
      async () => textContent(await client.request(session ? l.session : l.key)),
    );
  }

  // Session-only convenience tool — the legacy CF dispatcher is what the
  // signupgenius.com wizard itself uses, sometimes with fuller data than v3.
  if (session) {
    server.registerTool(
      'signupgenius_legacy_get_my_signups',
      {
        description:
          'Session mode only. Returns the same sign-up listing the SignUpGenius wizard sees ' +
          '(via /SUGboxAPI.cfm?go=t.getMySignups). Use when you want fuller data than ' +
          'signupgenius_list_created_* provides.',
        annotations: { readOnlyHint: true },
      },
      async () => textContent(await client.request('', { legacyAction: 't.getMySignups' })),
    );
  }
}
