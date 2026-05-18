import { describe, it, expect, afterEach, vi } from 'vitest';
import { setupTools, sessionAccount } from './_setup.js';
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
  it('POSTs with just emailaddress', async () => {
    const { handlers, requestSpy } = setupTools(registerGroupTools);
    await handlers.get('signupgenius_add_group_member')!({ groupId: 1, emailaddress: 'a@b.com' });
    expect(requestSpy).toHaveBeenCalledWith('/groups/1/members/create', {
      method: 'POST',
      body: { emailaddress: 'a@b.com' },
    });
  });

  it('includes firstname/lastname when provided', async () => {
    const { handlers, requestSpy } = setupTools(registerGroupTools);
    await handlers.get('signupgenius_add_group_member')!({
      groupId: 1,
      emailaddress: 'a@b.com',
      firstname: 'Ann',
      lastname: 'Lee',
    });
    expect(requestSpy).toHaveBeenCalledWith('/groups/1/members/create', {
      method: 'POST',
      body: { emailaddress: 'a@b.com', firstname: 'Ann', lastname: 'Lee' },
    });
  });

  it('rejects invalid email', async () => {
    const { handlers } = setupTools(registerGroupTools);
    await expect(
      handlers.get('signupgenius_add_group_member')!({ groupId: 1, emailaddress: 'nope' }),
    ).rejects.toThrow();
  });
});
