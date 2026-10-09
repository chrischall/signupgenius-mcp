import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { confirmTokenParam } from '@chrischall/mcp-utils';
import type { SignUpGeniusClient } from '../client.js';
import { confirmWrite, textContent } from './_shared.js';

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
  confirmToken: confirmTokenParam,
});

export function registerGroupTools(server: McpServer, client: SignUpGeniusClient): void {
  server.registerTool(
    'signupgenius_list_groups',
    {
      description:
        'List groups created by the authenticated user. Returns groupid, title, and member count for each group.',
      annotations: { readOnlyHint: true },
      inputSchema: listGroupsArgs,
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
      inputSchema: groupIdArgs,
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
      inputSchema: memberDetailArgs,
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
        'Add a person to one of your SignUpGenius groups by email address (first/last name ' +
        'optional). WRITES DATA: the person may start receiving the group\'s sign-up ' +
        'invitations, so it asks the user to confirm first: a confirmation prompt where the ' +
        'client supports one; otherwise the first call sends nothing and returns the preview ' +
        '(group, email, name) and a confirmToken, and only a repeat call with the same ' +
        'arguments plus that token adds them — show the preview to the user and get their ' +
        'approval first (MCP_CONFIRM_MODE).',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: addMemberArgs,
    },
    async (raw, ctx) => {
      const args = addMemberArgs.parse(raw);
      const body: Record<string, string> = { emailaddress: args.emailaddress };
      if (args.firstname !== undefined) body.firstname = args.firstname;
      if (args.lastname !== undefined) body.lastname = args.lastname;
      // fleet-audit#1115: adding a member puts a third party on the group's
      // mailing list. Bound to this tool, this group and the exact body.
      const gate = await confirmWrite(ctx, client, {
        tool: 'signupgenius_add_group_member',
        action: 'signupgenius.group.add_member',
        message:
          `Review and confirm adding ${args.emailaddress} to group ${args.groupId}. They may ` +
          "start receiving the group's sign-up invitations.",
        confirmationLabel: 'Add this person to the group now.',
        confirmToken: args.confirmToken,
        target: String(args.groupId),
        payload: body,
        preview: { groupId: args.groupId, ...body },
      });
      if (gate) return gate;
      const data = await client.request(`/groups/${args.groupId}/members/create`, {
        method: 'POST',
        body,
      });
      return textContent(data);
    },
  );
}
