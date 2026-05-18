import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SignUpGeniusClient } from '../client.js';
import { textContent } from './_shared.js';

const listGroupsArgs = z.object({
  sort: z.enum(['asc', 'desc']).optional().describe('Sort order for group results.'),
});

const groupIdArgs = z.object({
  groupId: z.number().int().positive().describe('Group ID returned by signupgenius_list_groups.'),
  sort: z.enum(['asc', 'desc']).optional(),
});

const memberDetailArgs = z.object({
  groupId: z.number().int().positive(),
  memberId: z.number().int().positive().describe('communitymemberid returned by signupgenius_list_group_members.'),
});

const addMemberArgs = z.object({
  groupId: z.number().int().positive(),
  emailaddress: z.string().email().describe('Email of the member to add to the group.'),
  firstname: z.string().optional(),
  lastname: z.string().optional(),
});

export function registerGroupTools(server: McpServer, client: SignUpGeniusClient): void {
  server.registerTool(
    'signupgenius_list_groups',
    {
      description:
        'List groups created by the authenticated user. Returns groupid, title, and member count for each group.',
      annotations: { readOnlyHint: true },
      inputSchema: listGroupsArgs.shape,
    },
    async (raw) => {
      const args = listGroupsArgs.parse(raw);
      const path = client.mode === 'session' ? '/groups/all' : '/groups';
      const data = await client.request(path, { query: { sort: args.sort } });
      return textContent(data);
    },
  );

  server.registerTool(
    'signupgenius_list_group_members',
    {
      description: 'List members of a SignUpGenius group (basic info: name, email, memberid).',
      annotations: { readOnlyHint: true },
      inputSchema: groupIdArgs.shape,
    },
    async (raw) => {
      const args = groupIdArgs.parse(raw);
      const data = await client.request(`/groups/${args.groupId}/members`, { query: { sort: args.sort } });
      return textContent(data);
    },
  );

  server.registerTool(
    'signupgenius_get_group_member',
    {
      description:
        'Get detailed info for a group member (address, phone, email) when the member has provided it via a sign-up.',
      annotations: { readOnlyHint: true },
      inputSchema: memberDetailArgs.shape,
    },
    async (raw) => {
      const args = memberDetailArgs.parse(raw);
      const data = await client.request(`/groups/${args.groupId}/members/${args.memberId}/details`);
      return textContent(data);
    },
  );

  server.registerTool(
    'signupgenius_add_group_member',
    {
      description:
        'Add a member to a SignUpGenius group by email address. First/last name are optional. ' +
        'Writes data — confirm with the user before invoking.',
      annotations: { readOnlyHint: false },
      inputSchema: addMemberArgs.shape,
    },
    async (raw) => {
      const args = addMemberArgs.parse(raw);
      const body: Record<string, string> = { emailaddress: args.emailaddress };
      if (args.firstname !== undefined) body.firstname = args.firstname;
      if (args.lastname !== undefined) body.lastname = args.lastname;
      const data = await client.request(`/groups/${args.groupId}/members/create`, {
        method: 'POST',
        body,
      });
      return textContent(data);
    },
  );
}
