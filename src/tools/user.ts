import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SignUpGeniusClient } from '../client.js';
import { textContent } from './_shared.js';

export function registerUserTools(server: McpServer, client: SignUpGeniusClient): void {
  server.registerTool(
    'signupgenius_get_profile',
    {
      description:
        "Get the SignUpGenius profile of the authenticated user (name, email, member ID, " +
        'subscription level). Useful as a first call to confirm credentials. ' +
        'Key mode hits /v2/k/user/profile; session mode hits /v3/member/profile.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const path = client.mode === 'session' ? '/member/profile' : '/user/profile';
      const data = await client.request(path);
      return textContent(data);
    },
  );
}
