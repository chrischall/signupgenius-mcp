#!/usr/bin/env node
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadDotenvSafely, runMcp } from '@chrischall/mcp-utils';

// quiet .env load — MCP stdout is JSON-RPC; any extra output corrupts the stream.
await loadDotenvSafely({
  path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env'),
});

import type { Account } from './config.js';
import { resolveAuth, type ResolvedAuth } from './auth.js';
import { SignUpGeniusClient } from './client.js';
import { registerUserTools } from './tools/user.js';
import { registerGroupTools } from './tools/groups.js';
import { registerSignUpTools } from './tools/signups.js';
import { registerReportTools } from './tools/reports.js';
import { registerPublicSignUpTools } from './tools/public-signup.js';
import { registerRsvpTool } from './tools/rsvp.js';

// Defer auth errors to tool-call time so the server still starts cleanly
// when env vars are missing (e.g. during the host's install-time smoke test,
// before the user has filled in user_config OR the user hasn't yet opened
// signupgenius.com in their browser). Tool invocations will surface the
// same error message they'd see if we threw here.
let account: Account | null = null;
let preloaded: ResolvedAuth['preloaded'];
let source: ResolvedAuth['source'] | undefined;
let configError: Error | null = null;
try {
  const resolved = await resolveAuth();
  account = resolved.account;
  preloaded = resolved.preloaded;
  source = resolved.source;
} catch (e) {
  configError = e as Error;
}

const client = new SignUpGeniusClient(account, {
  configError: configError ?? undefined,
  preloaded,
});

const bannerLines = account
  ? [
      `[signupgenius-mcp] SignUpGenius: ${account.name} (${account.baseUrl}) [${account.mode}]${
        source === 'fetchproxy' ? ' [via fetchproxy]' : ''
      }`,
    ]
  : [
      `[signupgenius-mcp] Not configured: ${configError?.message ?? 'unknown error'}`,
      '[signupgenius-mcp] Server is running but tool calls will fail until env vars are set.',
    ];
bannerLines.push(
  '[signupgenius-mcp] Developed and maintained by AI (Claude). Use at your own discretion.',
);

await runMcp({
  name: 'signupgenius',
  version: '1.1.1', // x-release-please-version
  banner: bannerLines.join('\n'),
  deps: client,
  tools: [
    (server, c) => registerUserTools(server, c),
    (server, c) => registerGroupTools(server, c),
    (server, c) => registerSignUpTools(server, c),
    (server, c) => registerReportTools(server, c),
    (server) => registerPublicSignUpTools(server),
    (server, c) => registerRsvpTool(server, c),
  ],
});
