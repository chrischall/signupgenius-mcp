import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SignUpGeniusClient } from '../client.js';
import { textContent } from './_shared.js';

const reportArgs = z.object({
  signupId: z.number().int().positive().describe('Sign-up ID (signupid).'),
});

/**
 * Report endpoints are Pro-only AND owner-scoped. We still register the tools
 * so Claude knows they exist, but in session mode they fail fast with the
 * shared ModeMismatchError, whose hint says "Switch to key mode to use
 * {tool}." — the SIGNUPGENIUS_USER_KEY pointer lives in each tool's
 * description below.
 *
 * These are NOT the general answer to "what slots are open?". A Pro key only
 * reports on sheets its holder created, so it cannot serve the common
 * participant case at all. `signupgenius_list_slots` covers that with no auth
 * (see slots.ts), and every failure path here points at it.
 */
export function registerReportTools(server: McpServer, client: SignUpGeniusClient): void {
  const register = (toolName: string, path: string, blurb: string) => {
    server.registerTool(
      toolName,
      {
        description:
          `${blurb} Requires SIGNUPGENIUS_USER_KEY (Pro subscription) — session mode is not ` +
          'supported for reports — AND only covers sheets the key-holder created. ' +
          'For slot dates, times and availability on ANY sign-up (including sheets the user ' +
          'did not create) prefer signupgenius_list_slots, which needs no auth.',
        annotations: { readOnlyHint: true },
        inputSchema: reportArgs.shape,
      },
      async (raw) => {
        // requireKeyMode, not requireMode: when auth config is deferred the
        // latter surfaces the fetchproxy/browser sign-in error, which can
        // never enable a Pro-only endpoint. See client.requireKeyMode().
        client.requireKeyMode(toolName);
        const args = reportArgs.parse(raw);
        const data = await client.request(`${path}/${args.signupId}`);
        return textContent(data);
      },
    );
  };

  register(
    'signupgenius_report_all',
    '/signups/report/all',
    'Full report for a sign-up: every slot plus the participant who claimed it (with custom-question answers when present).',
  );
  register(
    'signupgenius_report_filled',
    '/signups/report/filled',
    'Report for a sign-up restricted to slots that have already been filled.',
  );
  register(
    'signupgenius_report_available',
    '/signups/report/available',
    'Report for a sign-up restricted to slots that are still open/empty.',
  );
}
