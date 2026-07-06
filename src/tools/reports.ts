import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SignUpGeniusClient } from '../client.js';
import { textContent } from './_shared.js';

const reportArgs = z.object({
  signupId: z.number().int().positive().describe('Sign-up ID (signupid).'),
});

/**
 * Report endpoints are Pro-only. The session-mode v3 web API has no
 * equivalent — only the sign-up owner can pull report data, and the v3 paths
 * for it were not discovered during recon. We still register the tools so
 * Claude knows they exist, but in session mode they fail fast with the shared
 * ModeMismatchError, whose hint says "Switch to key mode to use {tool}." —
 * the SIGNUPGENIUS_USER_KEY pointer lives in each tool's description below.
 */
export function registerReportTools(server: McpServer, client: SignUpGeniusClient): void {
  const register = (toolName: string, path: string, blurb: string) => {
    server.registerTool(
      toolName,
      {
        description: `${blurb} Requires SIGNUPGENIUS_USER_KEY (Pro subscription) — session mode is not supported for reports.`,
        annotations: { readOnlyHint: true },
        inputSchema: reportArgs.shape,
      },
      async (raw) => {
        client.requireMode('key', toolName);
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
