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
import { loadAccount } from './config.js';
import { SignUpGeniusClient } from './client.js';
import { registerUserTools } from './tools/user.js';
import { registerGroupTools } from './tools/groups.js';
import { registerSignUpTools } from './tools/signups.js';
import { registerReportTools } from './tools/reports.js';

// Defer config errors to tool-call time so the server still starts cleanly
// when env vars are missing (e.g. during the host's install-time smoke test,
// before the user has filled in user_config). Tool invocations will surface
// the same error message they'd see if we threw here.
let account: ReturnType<typeof loadAccount> | null = null;
let configError: Error | null = null;
try {
  account = loadAccount();
} catch (e) {
  configError = e as Error;
}

const client = new SignUpGeniusClient(account, { configError: configError ?? undefined });
const server = new McpServer({ name: 'signupgenius', version: '1.0.1' });

registerUserTools(server, client);
registerGroupTools(server, client);
registerSignUpTools(server, client);
registerReportTools(server, client);

if (account) {
  console.error(
    `[signupgenius-mcp] SignUpGenius: ${account.name} (${account.baseUrl}) [${account.mode}]`,
  );
} else {
  console.error(`[signupgenius-mcp] Not configured: ${configError?.message ?? 'unknown error'}`);
  console.error('[signupgenius-mcp] Server is running but tool calls will fail until env vars are set.');
}
console.error('[signupgenius-mcp] Developed and maintained by AI (Claude). Use at your own discretion.');

const transport = new StdioServerTransport();
await server.connect(transport);
