import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { SignUpGeniusClient } from '../src/client.js';
import { registerGroupTools } from '../src/tools/groups.js';
import type { KeyAccount } from '../src/config.js';

const account: KeyAccount = {
  mode: 'key',
  name: 'test',
  baseUrl: 'https://api.signupgenius.com/v2/k',
  userKey: 'KEY',
};

describe('SDK v2 tool schemas', () => {
  it('publishes group member inputs through tools/list', async () => {
    const client = new SignUpGeniusClient(account);
    const harness = await createTestHarness((server) => registerGroupTools(server, client));
    const { tools } = await harness.client.listTools();
    const tool = tools.find((candidate) => candidate.name === 'signupgenius_list_group_members');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { groupId: { type: 'integer' } },
      required: ['groupId'],
    });
    await harness.close();
  });
});
