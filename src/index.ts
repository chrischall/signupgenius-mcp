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

const account = loadAccount();
const client = new SignUpGeniusClient(account);
const server = new McpServer({ name: 'signupgenius', version: '1.0.0' });

registerUserTools(server, client);
registerGroupTools(server, client);
registerSignUpTools(server, client);
registerReportTools(server, client);

console.error(
  `[signupgenius-mcp] SignUpGenius: ${account.name} (${account.baseUrl}) [${account.mode}]`,
);
console.error('[signupgenius-mcp] Developed and maintained by AI (Claude). Use at your own discretion.');

const transport = new StdioServerTransport();
await server.connect(transport);
