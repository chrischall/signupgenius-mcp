import { McpServer } from '@modelcontextprotocol/server';
import type { SignUpGeniusClient } from '../client.js';
import { z } from 'zod';
import { schoolMeta, textContent, type MintHint } from './_shared.js';
import { briefResponse, briefViewArg, type BriefKind } from './brief.js';

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
  /** Context-group hint (`_meta.mint`). */
  mint: { mint: MintHint };
  /** Set on the canonical reads: they take `view: 'brief'`. */
  brief?: BriefKind;
}

const CREATED = schoolMeta('lookup', { aliases: ['my sign-ups', 'sheets i made', 'signupgenius'] });

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
    mint: CREATED,
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
    mint: CREATED,
  },
  {
    name: 'signupgenius_list_created_all',
    session: '/signups/created',
    key: '/signups/created/all',
    desc: {
      key: 'List ALL sign-ups created by the API key holder (active and expired).',
      session: 'List ALL sign-ups created by the authenticated user (active and expired).',
    },
    mint: CREATED,
  },
  {
    name: 'signupgenius_list_invited',
    session: '/signups/invited',
    key: '/signups/invited/active',
    desc: {
      key: 'List sign-ups the user has been invited to. Not applicable to sub-admin credentials.',
      session: 'List sign-ups the user has been invited to.',
    },
    mint: schoolMeta('whats-new', {
      canonical: true,
      aliases: ['invitations', 'invited', 'new sign-ups', 'volunteer requests', 'signupgenius'],
    }),
    brief: 'invited',
  },
  {
    name: 'signupgenius_list_signedupfor',
    session: '/signups/signedupfor',
    key: '/signups/signedupfor/active',
    desc: {
      key: 'List sign-ups the user has personally signed up for. Not applicable to sub-admin credentials.',
      session: 'List sign-ups the user has personally signed up for.',
    },
    mint: schoolMeta('whats-on', {
      canonical: true,
      aliases: ['signed up', 'volunteering', 'my slots', 'my sign-ups', 'signupgenius', 'potluck', 'rsvps'],
    }),
    brief: 'signedupfor',
  },
];

export function registerSignUpTools(server: McpServer, client: SignUpGeniusClient): void {
  const session = client.mode === 'session';

  for (const l of LISTINGS) {
    const path = session ? l.session : l.key;
    const description = session ? l.desc.session : l.desc.key;
    const kind = l.brief;
    if (kind) {
      const args = z.object({ view: briefViewArg });
      server.registerTool(
        l.name,
        {
          description: `${description} view: "brief" answers one line per sign-up (title — date — status).`,
          annotations: { readOnlyHint: true, openWorldHint: true },
          _meta: l.mint,
          inputSchema: args,
        },
        async (raw) => {
          const { view } = args.parse(raw);
          const data = await client.request(path);
          return view === 'brief' ? briefResponse(data, kind) : textContent(data);
        },
      );
    } else {
      server.registerTool(
        l.name,
        { description, annotations: { readOnlyHint: true, openWorldHint: true }, _meta: l.mint },
        async () => textContent(await client.request(path)),
      );
    }
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
        annotations: { readOnlyHint: true, openWorldHint: true },
        _meta: schoolMeta('lookup'),
      },
      async () => textContent(await client.request('', { legacyAction: 't.getMySignups' })),
    );
  }
}
