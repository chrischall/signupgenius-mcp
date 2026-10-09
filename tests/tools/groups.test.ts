import { describe, it, expect, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import {
  setupTools,
  sessionAccount,
  confirmViaToken,
  parseText,
  ACCEPT_CTX,
  DECLINE_CTX,
  TOKEN_CTX,
} from './_setup.js';
import { SignUpGeniusClient } from '../../src/client.js';
import { registerGroupTools } from '../../src/tools/groups.js';

afterEach(() => vi.restoreAllMocks());

describe('signupgenius_list_groups', () => {
  it('uses /groups in key mode', async () => {
    const { handlers, requestSpy } = setupTools(registerGroupTools);
    await handlers.get('signupgenius_list_groups')!({});
    expect(requestSpy).toHaveBeenCalledWith('/groups', { query: { sort: undefined } });
  });

  it('uses /groups/all in session mode and passes the sort param', async () => {
    const { handlers, requestSpy } = setupTools(registerGroupTools, sessionAccount);
    await handlers.get('signupgenius_list_groups')!({ sort: 'desc' });
    expect(requestSpy).toHaveBeenCalledWith('/groups/all', { query: { sort: 'desc' } });
  });

  it('rejects invalid sort values', async () => {
    const { handlers } = setupTools(registerGroupTools);
    await expect(handlers.get('signupgenius_list_groups')!({ sort: 'sideways' })).rejects.toThrow();
  });
});

describe('signupgenius_list_group_members', () => {
  it('calls /groups/{id}/members with sort', async () => {
    const { handlers, requestSpy } = setupTools(registerGroupTools);
    await handlers.get('signupgenius_list_group_members')!({ groupId: 42, sort: 'asc' });
    expect(requestSpy).toHaveBeenCalledWith('/groups/42/members', { query: { sort: 'asc' } });
  });

  it('requires groupId', async () => {
    const { handlers } = setupTools(registerGroupTools);
    await expect(handlers.get('signupgenius_list_group_members')!({})).rejects.toThrow();
  });
});

describe('signupgenius_get_group_member', () => {
  it('calls /groups/{id}/members/{m}/details', async () => {
    const { handlers, requestSpy } = setupTools(registerGroupTools);
    await handlers.get('signupgenius_get_group_member')!({ groupId: 1, memberId: 7 });
    expect(requestSpy).toHaveBeenCalledWith('/groups/1/members/7/details');
  });
});

describe('signupgenius_add_group_member', () => {
  const CREATE = '/groups/1/members/create';
  const created = (spy: ReturnType<typeof setupTools>['requestSpy']) =>
    spy.mock.calls.filter(([p]) => p === CREATE);

  // fleet-audit#1115: adding someone puts a third party on the group's mailing
  // list, so the first call must never write — the same confirm gate as the
  // other writes, not just prose in the description.
  it('previews WITHOUT writing on the first call, returning a confirmToken', async () => {
    const { handlers, requestSpy } = setupTools(registerGroupTools);
    const out = parseText(
      await handlers.get('signupgenius_add_group_member')!(
        { groupId: 1, emailaddress: 'a@b.com', firstname: 'Ann' },
        TOKEN_CTX,
      ),
    );
    expect(out.status).toBe('confirmation-required');
    expect(typeof out.confirmToken).toBe('string');
    expect(JSON.stringify(out)).toContain('a@b.com');
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('ignores a model-supplied confirm:true on the first call', async () => {
    const { handlers, requestSpy } = setupTools(registerGroupTools);
    await handlers.get('signupgenius_add_group_member')!(
      { groupId: 1, emailaddress: 'a@b.com', confirm: true },
      TOKEN_CTX,
    );
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('POSTs with just emailaddress on the token round-trip', async () => {
    const { handlers, requestSpy } = setupTools(registerGroupTools);
    await confirmViaToken(handlers.get('signupgenius_add_group_member')!, {
      groupId: 1,
      emailaddress: 'a@b.com',
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith(CREATE, {
      method: 'POST',
      body: { emailaddress: 'a@b.com' },
    });
  });

  it('includes firstname/lastname when provided', async () => {
    const { handlers, requestSpy } = setupTools(registerGroupTools);
    await confirmViaToken(handlers.get('signupgenius_add_group_member')!, {
      groupId: 1,
      emailaddress: 'a@b.com',
      firstname: 'Ann',
      lastname: 'Lee',
    });
    expect(requestSpy).toHaveBeenCalledWith(CREATE, {
      method: 'POST',
      body: { emailaddress: 'a@b.com', firstname: 'Ann', lastname: 'Lee' },
    });
  });

  it('writes in one call when an elicitation prompt was accepted', async () => {
    const { handlers, requestSpy } = setupTools(registerGroupTools, sessionAccount);
    await handlers.get('signupgenius_add_group_member')!(
      { groupId: 1, emailaddress: 'a@b.com' },
      ACCEPT_CTX,
    );
    expect(created(requestSpy)).toHaveLength(1);
  });

  it('does not write when the prompt was declined', async () => {
    const { handlers, requestSpy } = setupTools(registerGroupTools);
    await handlers.get('signupgenius_add_group_member')!(
      { groupId: 1, emailaddress: 'a@b.com' },
      DECLINE_CTX,
    );
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('rejects a token replayed against a different person', async () => {
    const { handlers, requestSpy } = setupTools(registerGroupTools);
    const h = handlers.get('signupgenius_add_group_member')!;
    const phase1 = parseText(await h({ groupId: 1, emailaddress: 'a@b.com' }, TOKEN_CTX));
    const out = parseText(
      await h({ groupId: 1, emailaddress: 'other@b.com', confirmToken: phase1.confirmToken }, TOKEN_CTX),
    );
    expect(out.error).toBe('DRAFT_CHANGED');
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('declares explicit, non-destructive write annotations', () => {
    const client = new SignUpGeniusClient(sessionAccount);
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const configs = new Map<string, { annotations?: Record<string, unknown> }>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, c: unknown) => {
      configs.set(name, c as { annotations?: Record<string, unknown> });
      return undefined as never;
    });
    registerGroupTools(server, client);
    expect(configs.get('signupgenius_add_group_member')!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it('rejects invalid email', async () => {
    const { handlers } = setupTools(registerGroupTools);
    await expect(
      handlers.get('signupgenius_add_group_member')!({ groupId: 1, emailaddress: 'nope' }),
    ).rejects.toThrow();
  });
});
