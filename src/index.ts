#!/usr/bin/env node
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

try {
  const { config } = await import('dotenv');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // quiet:true suppresses dotenv's startup banner — MCP uses stdout for
  // JSON-RPC, and any extra output corrupts the stream.
  config({ path: join(__dirname, '..', '.env'), override: false, quiet: true });
} catch {
  // dotenv not available — rely on process.env
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Account } from './config.js';
import { resolveAuth, type ResolvedAuth } from './auth.js';
import { SignUpGeniusClient } from './client.js';
import { registerUserTools } from './tools/user.js';
import { registerGroupTools } from './tools/groups.js';
import { registerSignUpTools } from './tools/signups.js';
import { registerReportTools } from './tools/reports.js';

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
const server = new McpServer({ name: 'signupgenius', version: '1.0.2' });

registerUserTools(server, client);
registerGroupTools(server, client);
registerSignUpTools(server, client);
registerReportTools(server, client);

if (account) {
  const suffix = source === 'fetchproxy' ? ' [via fetchproxy]' : '';
  console.error(
    `[signupgenius-mcp] SignUpGenius: ${account.name} (${account.baseUrl}) [${account.mode}]${suffix}`,
  );
} else {
  console.error(`[signupgenius-mcp] Not configured: ${configError?.message ?? 'unknown error'}`);
  console.error('[signupgenius-mcp] Server is running but tool calls will fail until env vars are set.');
}
console.error('[signupgenius-mcp] Developed and maintained by AI (Claude). Use at your own discretion.');

const transport = new StdioServerTransport();
await server.connect(transport);
