import { describe, it, expect, afterEach, vi } from 'vitest';
import { setupTools, sessionAccount } from './_setup.js';
import { registerSignUpTools } from '../../src/tools/signups.js';

afterEach(() => vi.restoreAllMocks());

const keyCases: Array<[string, string]> = [
  ['signupgenius_list_created_active', '/signups/created/active'],
  ['signupgenius_list_created_expired', '/signups/created/expired'],
  ['signupgenius_list_created_all', '/signups/created/all'],
  ['signupgenius_list_invited', '/signups/invited/active'],
  ['signupgenius_list_signedupfor', '/signups/signedupfor/active'],
];

describe.each(keyCases)('key mode: %s', (toolName, path) => {
  it(`calls ${path}`, async () => {
    const { handlers, requestSpy } = setupTools(registerSignUpTools);
    await handlers.get(toolName)!({});
    expect(requestSpy).toHaveBeenCalledWith(path);
  });
});

const sessionCases: Array<[string, string]> = [
  ['signupgenius_list_created_active', '/signups/created'],
  ['signupgenius_list_created_expired', '/signups/created'],
  ['signupgenius_list_created_all', '/signups/created'],
  ['signupgenius_list_invited', '/signups/invited'],
  ['signupgenius_list_signedupfor', '/signups/signedupfor'],
];

describe.each(sessionCases)('session mode: %s', (toolName, path) => {
  it(`calls ${path}`, async () => {
    const { handlers, requestSpy } = setupTools(registerSignUpTools, sessionAccount);
    await handlers.get(toolName)!({});
    expect(requestSpy).toHaveBeenCalledWith(path);
  });
});

describe('signupgenius_legacy_get_my_signups', () => {
  it('is only registered in session mode and dispatches to t.getMySignups', async () => {
    const { handlers: keyHandlers } = setupTools(registerSignUpTools);
    expect(keyHandlers.get('signupgenius_legacy_get_my_signups')).toBeUndefined();

    const { handlers, requestSpy } = setupTools(registerSignUpTools, sessionAccount);
    await handlers.get('signupgenius_legacy_get_my_signups')!({});
    expect(requestSpy).toHaveBeenCalledWith('', { legacyAction: 't.getMySignups' });
  });
});
