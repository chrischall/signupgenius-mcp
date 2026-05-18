import { describe, it, expect, afterEach, vi } from 'vitest';
import { setupTools, sessionAccount } from './_setup.js';
import { registerUserTools } from '../../src/tools/user.js';

afterEach(() => vi.restoreAllMocks());

describe('signupgenius_get_profile', () => {
  it('calls /user/profile in key mode', async () => {
    const { handlers, requestSpy } = setupTools(registerUserTools);
    await handlers.get('signupgenius_get_profile')!({});
    expect(requestSpy).toHaveBeenCalledWith('/user/profile');
  });

  it('calls /member/profile in session mode', async () => {
    const { handlers, requestSpy } = setupTools(registerUserTools, sessionAccount);
    await handlers.get('signupgenius_get_profile')!({});
    expect(requestSpy).toHaveBeenCalledWith('/member/profile');
  });
});
