import { describe, it, expect, afterEach, vi } from 'vitest';
import { SignUpGeniusClient } from '../../src/client.js';
import {
  formatIdentity,
  profilePath,
  readProfile,
  resolveIdentity,
  type ProfileLookup,
} from '../../src/tools/identity.js';
import { keyAccount, sessionAccount } from './_setup.js';

afterEach(() => vi.restoreAllMocks());

/** Synthetic account — never a real member's details. */
const ACCOUNT = { firstname: 'Pat', lastname: 'Rivera', email: 'pat@example.com' };
const OK: ProfileLookup = { status: 'ok', memberId: 1001, identity: ACCOUNT };

function clientReturning(account: typeof keyAccount | typeof sessionAccount, impl: () => unknown) {
  const client = new SignUpGeniusClient(account);
  const spy = vi.spyOn(client, 'request').mockImplementation((async () => impl()) as never);
  return { client, spy };
}

describe('profilePath', () => {
  it('matches signupgenius_get_profile: /member/profile in session mode, /user/profile in key mode', () => {
    expect(profilePath('session')).toBe('/member/profile');
    expect(profilePath('key')).toBe('/user/profile');
  });
});

describe('readProfile', () => {
  it('reads name, email and id from the session (v3) profile', async () => {
    const { client, spy } = clientReturning(sessionAccount, () => ({
      success: true,
      message: [],
      data: { ...ACCOUNT, id: 1001, isemailverified: true },
    }));
    expect(await readProfile(client)).toEqual({ status: 'ok', memberId: 1001, identity: ACCOUNT });
    expect(spy).toHaveBeenCalledWith('/member/profile');
  });

  it('reads the key-mode (v2/k) profile, tolerating upper-case keys and memberid', async () => {
    const { client, spy } = clientReturning(keyAccount, () => ({
      success: true,
      message: [],
      data: { FIRSTNAME: ' Pat ', LastName: 'Rivera', EMAIL: 'pat@example.com', MEMBERID: 1001 },
    }));
    expect(await readProfile(client)).toEqual({ status: 'ok', memberId: 1001, identity: ACCOUNT });
    expect(spy).toHaveBeenCalledWith('/user/profile');
  });

  it('accepts a profile wrapped in a one-element array', async () => {
    const { client } = clientReturning(keyAccount, () => ({ data: [{ ...ACCOUNT, id: 7 }] }));
    expect(await readProfile(client)).toEqual({ status: 'ok', memberId: 7, identity: ACCOUNT });
  });

  it('drops blank or non-string identity fields and a non-numeric id', async () => {
    const { client } = clientReturning(sessionAccount, () => ({
      data: { firstname: '  ', lastname: 5, email: 'pat@example.com', id: '1001' },
    }));
    expect(await readProfile(client)).toEqual({
      status: 'ok',
      memberId: undefined,
      identity: { email: 'pat@example.com' },
    });
  });

  it('treats a non-object payload as an empty profile', async () => {
    const { client } = clientReturning(sessionAccount, () => ({ data: null }));
    expect(await readProfile(client)).toEqual({ status: 'ok', memberId: undefined, identity: {} });
  });

  it('never throws — a failed lookup comes back as unknown', async () => {
    const { client } = clientReturning(sessionAccount, () => {
      throw new Error('session expired');
    });
    expect(await readProfile(client)).toEqual({
      status: 'unknown',
      reason: 'profile lookup failed: session expired',
    });
  });

  it('reports a non-Error rejection verbatim', async () => {
    const { client } = clientReturning(sessionAccount, () => {
      throw 'down';
    });
    expect(await readProfile(client)).toEqual({
      status: 'unknown',
      reason: 'profile lookup failed: down',
    });
  });
});

describe('formatIdentity', () => {
  it('renders "First Last <email>"', () => {
    expect(formatIdentity(ACCOUNT)).toBe('Pat Rivera <pat@example.com>');
  });
});

describe('resolveIdentity', () => {
  it('defaults every omitted field from the account', () => {
    const r = resolveIdentity({}, OK);
    expect(r.identity).toEqual(ACCOUNT);
    expect(r.differs).toBe(false);
    expect(r.preview).toEqual({
      name: 'Pat Rivera',
      email: 'pat@example.com',
      source: 'account',
      fromAccount: ['firstname', 'lastname', 'email'],
      supplied: [],
      account: 'Pat Rivera <pat@example.com>',
    });
    expect(r.note).toBeUndefined();
  });

  it('labels a fully supplied identity that matches the account (trimmed names, any-case email)', () => {
    const r = resolveIdentity(
      { firstname: ' Pat ', lastname: 'Rivera', email: 'PAT@Example.com' },
      OK,
    );
    expect(r.differs).toBe(false);
    expect(r.identity).toEqual({ firstname: 'Pat', lastname: 'Rivera', email: 'PAT@Example.com' });
    expect(r.preview.source).toBe('supplied');
    expect(r.preview.supplied).toEqual(['firstname', 'lastname', 'email']);
  });

  it('flags a supplied identity that differs, naming both identities', () => {
    const r = resolveIdentity({ firstname: 'Sam', email: 'sam@example.com' }, OK);
    expect(r.identity).toEqual({ firstname: 'Sam', lastname: 'Rivera', email: 'sam@example.com' });
    expect(r.differs).toBe(true);
    expect(r.preview.source).toBe('mixed');
    expect(r.preview.fromAccount).toEqual(['lastname']);
    expect(r.preview.supplied).toEqual(['firstname', 'email']);
    expect(r.note).toMatch(/Sam Rivera <sam@example\.com>/);
    expect(r.note).toMatch(/Pat Rivera <pat@example\.com>/);
    expect(r.note).toMatch(/family member/);
  });

  it('flags a different name even when the email matches', () => {
    expect(resolveIdentity({ lastname: 'Other' }, OK).differs).toBe(true);
  });

  it('proceeds with a fully supplied identity when the profile is unreadable, saying it could not compare', () => {
    const r = resolveIdentity(
      { firstname: 'Sam', lastname: 'Rivera', email: 'sam@example.com' },
      { status: 'unknown', reason: 'profile lookup failed: x' },
    );
    expect(r.differs).toBe(false);
    expect(r.preview.account).toBe('unavailable (profile lookup failed: x)');
    expect(r.preview.accountCheck).toMatch(/could not compare.*profile lookup failed: x/);
  });

  it('says so when the profile lacks a field the caller supplied', () => {
    const r = resolveIdentity(
      { firstname: 'Pat', lastname: 'Rivera', email: 'pat@example.com' },
      { status: 'ok', identity: { email: 'pat@example.com' } },
    );
    expect(r.differs).toBe(false);
    expect(r.preview.account).toBe('incomplete (firstname, lastname missing)');
    expect(r.preview.accountCheck).toMatch(/could not compare firstname, lastname/);
  });

  it('refuses to guess an omitted field the account cannot supply', () => {
    expect(() =>
      resolveIdentity({ firstname: 'Pat' }, { status: 'unknown', reason: 'profile lookup failed: x' }),
    ).toThrow(/lastname, email.*profile lookup failed: x.*pass firstname, lastname and email/s);
    expect(() =>
      resolveIdentity({}, { status: 'ok', identity: { firstname: 'Pat', lastname: 'Rivera' } }),
    ).toThrow(/Could not read email from your SignUpGenius profile \(field missing\)/);
  });
});
