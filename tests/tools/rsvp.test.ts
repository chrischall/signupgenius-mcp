import { describe, it, expect, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { SignUpGeniusClient } from '../../src/client.js';
import {
  keyAccount,
  sessionAccount,
  ACCEPT_CTX,
  TOKEN_CTX,
  confirmViaToken,
  parseText,
  type Handler,
} from './_setup.js';
import {
  buildRsvpPayload,
  describeResponse,
  findOwnResponse,
  registerRsvpTool,
  type SignupInfo,
} from '../../src/tools/rsvp.js';
import { parseSignUpUrl } from '../../src/tools/public-signup.js';

afterEach(() => vi.restoreAllMocks());

const SLUG = '10C054DA9AF2BA0FEC07-63774883-myers';
const URL_FULL = `https://www.signupgenius.com/go/${SLUG}`;

const RSVP_INFO: SignupInfo = {
  id: 63774883,
  owner: 16823335,
  urlid: SLUG,
  title: 'Myers Park Bands Spring Banquet',
  useRSVP: 1,
  emailrequired: 1,
  rsvpdetails: {
    slotid: 815208881,
    starttime: 'May, 21 2026 17:00:00',
    endtime: 'May, 21 2026 18:30:00',
    location: 'Myers Park Cafeteria',
    usetime: 1,
    rsvpitems: [],
  },
} as SignupInfo;

const SLOT_INFO: SignupInfo = { ...RSVP_INFO, useRSVP: 0 };

const ITEM_RSVP_INFO: SignupInfo = {
  ...RSVP_INFO,
  rsvpdetails: {
    ...RSVP_INFO.rsvpdetails,
    rsvpitems: [
      { slotitemid: 1, item: 'Lasagna', qty: 4, availableqty: 4 },
    ] as never,
  },
} as SignupInfo;

describe('buildRsvpPayload', () => {
  const parts = parseSignUpUrl(URL_FULL);

  it('matches the wizard wire format exactly for a YES headcount-only RSVP', () => {
    // Regression for signupid 63774883 ("Myers Park Bands Spring Banquet").
    // Server rejected the previous shape with "key [RSVPITEMS] doesn't exist"
    // because the CFML validator unconditionally reads RSVPITEMS from the
    // payload struct. The fix tracks `/dist/js/signups/signup.min.js`'s
    // `d.ProcessSignUp` so every key the wizard sends is present.
    const p = buildRsvpPayload(parts, RSVP_INFO, {
      url: URL_FULL,
      response: 'yes',
      firstname: 'Chris',
      lastname: 'Hall',
      email: 'chris@example.com',
    });
    expect(p).toEqual({
      listid: 63774883,
      owner: 16823335,
      urlid: SLUG,
      title: 'Myers Park Bands Spring Banquet',
      siid: '',
      rsvpid: 0,
      imid: 0,
      usealternatename: false,
      changemembermame: false,
      displayfirstname: 'Chris',
      displaylastname: 'Hall',
      firstname: 'Chris',
      lastname: 'Hall',
      email: 'chris@example.com',
      optInStatus: false,
      savecontactinfo: false,
      rsvpresponse: 'y',
      rsvpadult: 1,
      rsvpchildren: 0,
      rsvpitems: [],
      rsvpcomments: '',
      type: 'rsvp',
      source: 'main',
      slotid: 815208881,
      isLoggedin: true,
      payLater: false,
      customFields: [],
    });
  });

  it('zeroes guest counts on a NO response (mirrors the wizard JS)', () => {
    const p = buildRsvpPayload(parts, RSVP_INFO, {
      url: URL_FULL,
      response: 'no',
      adults: 4,
      children: 2,
      firstname: 'A',
      lastname: 'B',
      email: 'x@y.co',
    });
    expect(p.rsvpresponse).toBe('n');
    expect(p.rsvpadult).toBe(0);
    expect(p.rsvpchildren).toBe(0);
  });

  it('honors adult and child counts on YES and MAYBE responses', () => {
    const yes = buildRsvpPayload(parts, RSVP_INFO, {
      url: URL_FULL, response: 'yes', adults: 3, children: 1,
      firstname: 'A', lastname: 'B', email: 'x@y.co',
    });
    expect(yes).toMatchObject({ rsvpresponse: 'y', rsvpadult: 3, rsvpchildren: 1 });

    const maybe = buildRsvpPayload(parts, RSVP_INFO, {
      url: URL_FULL, response: 'maybe', adults: 2, children: 4,
      firstname: 'A', lastname: 'B', email: 'x@y.co',
    });
    expect(maybe).toMatchObject({ rsvpresponse: 'm', rsvpadult: 2, rsvpchildren: 4 });
  });

  it('includes a comment when provided, under the wizard\'s rsvpcomments key', () => {
    const p = buildRsvpPayload(parts, RSVP_INFO, {
      url: URL_FULL, response: 'yes', comment: 'Excited!',
      firstname: 'A', lastname: 'B', email: 'x@y.co',
    });
    expect(p.rsvpcomments).toBe('Excited!');
  });

  it('always sends rsvpitems as an empty array on the headcount-only variant', () => {
    const p = buildRsvpPayload(parts, RSVP_INFO, {
      url: URL_FULL, response: 'yes',
      firstname: 'A', lastname: 'B', email: 'x@y.co',
    });
    expect(p.rsvpitems).toEqual([]);
  });
});

/** The signed-in account's profile (synthetic). */
const PROFILE = { id: 1001, firstname: 'Pat', lastname: 'Rivera', email: 'pat@example.com' };

function makeClient(
  account = sessionAccount,
  signedUpFor: unknown = [],
  profile: (() => unknown) | unknown = PROFILE,
) {
  const client = new SignUpGeniusClient(account);
  const requestSpy = vi.spyOn(client, 'request').mockImplementation(async (path, opts) => {
    if (path === '/member/profile') {
      const data = typeof profile === 'function' ? (profile as () => unknown)() : profile;
      return { data, message: [], success: true } as never;
    }
    if (path === '/signups/signedupfor') {
      return { data: signedUpFor, message: [], success: true } as never;
    }
    if (opts?.legacyAction === 's.getSignupInfo') {
      return { data: RSVP_INFO, message: [], success: true } as never;
    }
    if (opts?.legacyAction === 's.processSignUpFormHandler') {
      return {
        data: { signupid: 63774883, message: 'You have successfully signed up.' },
        message: [],
        success: true,
      } as never;
    }
    throw new Error(`unexpected request: ${path} / ${JSON.stringify(opts)}`);
  });
  const preSpy = vi
    .spyOn(client, 'preProcessSignUp')
    .mockResolvedValue(undefined);
  return { client, requestSpy, preSpy };
}

function attachTool(client: SignUpGeniusClient) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const handlers = new Map<string, Handler>();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _c: unknown, cb: unknown) => {
    // Default to a no-elicitation caller, the common hosted case.
    handlers.set(name, (args, ctx = TOKEN_CTX) => (cb as Handler)(args, ctx));
    return undefined as never;
  });
  registerRsvpTool(server, client);
  return handlers;
}

describe('signupgenius_rsvp tool', () => {
  it('is not registered in key mode', () => {
    const client = new SignUpGeniusClient(keyAccount);
    const handlers = attachTool(client);
    expect(handlers.get('signupgenius_rsvp')).toBeUndefined();
  });

  it('previews WITHOUT writing on the first call, returning a confirmToken', async () => {
    // Parity with claim_slot/release_slot: a real RSVP under the user's name
    // must never reach the organizer on the first call.
    const { client, requestSpy, preSpy } = makeClient();
    const handlers = attachTool(client);

    const result = (await handlers.get('signupgenius_rsvp')!({
      url: URL_FULL,
      response: 'yes',
      adults: 4,
      firstname: 'Pat',
      lastname: 'Rivera',
      email: 'pat@example.com',
    })) as { content: Array<{ text: string }> };

    const res = JSON.parse(result.content[0].text);
    expect(res.status).toBe('confirmation-required');
    expect(typeof res.confirmToken).toBe('string');
    const out = res.preview;
    // The preview names the sheet by title, not only by id.
    expect(out.title).toBe('Myers Park Bands Spring Banquet');
    expect(out).toMatchObject({ response: 'yes', adults: 4, children: 0 });
    expect(out.respondingAs).toBe('Pat Rivera <pat@example.com>');
    expect(out.duplicateCheck).toMatch(/no existing response/);
    // Only reads happened: no PreProcessSignup, no submit.
    expect(preSpy).not.toHaveBeenCalled();
    expect(requestSpy).toHaveBeenCalledTimes(3);
    expect(requestSpy).toHaveBeenCalledWith('/member/profile');
    expect(requestSpy).toHaveBeenCalledWith('', {
      legacyAction: 's.getSignupInfo',
      body: { urlid: SLUG },
    });
    expect(requestSpy).toHaveBeenCalledWith('/signups/signedupfor');
    expect(requestSpy).not.toHaveBeenCalledWith('', expect.objectContaining({
      legacyAction: 's.processSignUpFormHandler',
    }));
  });

  it('ignores a model-supplied confirm:true on the first call — nothing is sent (SEC-1)', async () => {
    // The old gate trusted `confirm: true`, so an over-eager or injected model
    // could RSVP in the user's name in one shot without any preview.
    const { client, requestSpy, preSpy } = makeClient();
    const handlers = attachTool(client);
    const out = parseText(
      await handlers.get('signupgenius_rsvp')!(
        { url: URL_FULL, response: 'no', firstname: 'A', lastname: 'B', email: 'x@y.co', confirm: true },
        TOKEN_CTX,
      ),
    );
    expect(out.status).toBe('confirmation-required');
    expect(preSpy).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalledWith('', expect.objectContaining({
      legacyAction: 's.processSignUpFormHandler',
    }));
  });

  it('submits on the token round-trip (SEC-1)', async () => {
    const { client, requestSpy, preSpy } = makeClient();
    const handlers = attachTool(client);
    const out = parseText(
      await confirmViaToken(handlers.get('signupgenius_rsvp')!, {
        url: URL_FULL, response: 'yes', firstname: 'A', lastname: 'B', email: 'x@y.co',
      }),
    );
    expect(out.submitted).toBe(true);
    expect(preSpy).toHaveBeenCalledTimes(1);
    expect(
      requestSpy.mock.calls.filter(
        ([, o]) => (o as { legacyAction?: string } | undefined)?.legacyAction === 's.processSignUpFormHandler',
      ),
    ).toHaveLength(1);
  });

  it('rejects a token replayed against a different response (SEC-1)', async () => {
    const { client, requestSpy, preSpy } = makeClient();
    const handlers = attachTool(client);
    const h = handlers.get('signupgenius_rsvp')!;
    const base = { url: URL_FULL, response: 'no', firstname: 'A', lastname: 'B', email: 'x@y.co' };
    const phase1 = parseText(await h(base, TOKEN_CTX));
    const out = parseText(
      await h({ ...base, response: 'yes', adults: 6, confirmToken: phase1.confirmToken }, TOKEN_CTX),
    );
    expect(out.error).toBe('DRAFT_CHANGED');
    expect(preSpy).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalledWith('', expect.objectContaining({
      legacyAction: 's.processSignUpFormHandler',
    }));
  });

  it('declares explicit write annotations', () => {
    const client = new SignUpGeniusClient(sessionAccount);
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const configs = new Map<string, { annotations?: Record<string, unknown> }>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, c: unknown) => {
      configs.set(name, c as { annotations?: Record<string, unknown> });
      return undefined as never;
    });
    registerRsvpTool(server, client);
    expect(configs.get('signupgenius_rsvp')!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it('walks getSignupInfo → signedupfor check → PreProcess → processSignUpFormHandler when confirmed', async () => {
    const { client, requestSpy, preSpy } = makeClient();
    const handlers = attachTool(client);

    const result = (await handlers.get('signupgenius_rsvp')!({
      url: URL_FULL,
      response: 'yes',
      firstname: 'Chris',
      lastname: 'Hall',
      email: 'chris@example.com',
    }, ACCEPT_CTX)) as { content: Array<{ text: string }> };

    expect(preSpy).toHaveBeenCalledWith(SLUG);
    expect(requestSpy).toHaveBeenNthCalledWith(1, '', {
      legacyAction: 's.getSignupInfo',
      body: { urlid: SLUG },
    });
    expect(requestSpy).toHaveBeenNthCalledWith(2, '/signups/signedupfor');
    expect(requestSpy).toHaveBeenNthCalledWith(3, '/member/profile');
    expect(requestSpy).toHaveBeenNthCalledWith(4, '', {
      legacyAction: 's.processSignUpFormHandler',
      body: expect.objectContaining({
        type: 'rsvp',
        urlid: SLUG,
        listid: 63774883,
        slotid: 815208881,
        rsvpresponse: 'y',
        rsvpitems: [],
      }),
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.submitted).toBe(true);
  });

  describe('responding identity (#706)', () => {
    const BASE = { url: URL_FULL, response: 'yes' };
    const submittedBody = (spy: ReturnType<typeof makeClient>['requestSpy']) =>
      spy.mock.calls.find(
        ([, o]) => (o as { legacyAction?: string } | undefined)?.legacyAction === 's.processSignUpFormHandler',
      )![1] as { body: Record<string, unknown> };

    it('defaults an omitted identity to the signed-in account', async () => {
      const { client, requestSpy } = makeClient();
      const h = attachTool(client).get('signupgenius_rsvp')!;
      const out = parseText(await h(BASE, TOKEN_CTX)).preview;
      expect(out.respondingAs).toBe('Pat Rivera <pat@example.com>');
      expect(out.identity).toMatchObject({ source: 'account', fromAccount: ['firstname', 'lastname', 'email'] });
      expect(out).not.toHaveProperty('identityDiffersFromAccount');

      await confirmViaToken(h, BASE);
      expect(submittedBody(requestSpy).body).toMatchObject({
        firstname: 'Pat',
        lastname: 'Rivera',
        email: 'pat@example.com',
        displayfirstname: 'Pat',
      });
    });

    it('flags — but does not block — a different identity, naming both', async () => {
      const { client, requestSpy } = makeClient();
      const h = attachTool(client).get('signupgenius_rsvp')!;
      const other = { ...BASE, firstname: 'Sam', lastname: 'Rivera', email: 'sam@example.com' };
      const out = parseText(await h(other, TOKEN_CTX)).preview;
      expect(out.identityDiffersFromAccount).toBe(true);
      expect(out.identityNote).toMatch(/Sam Rivera <sam@example\.com>.*Pat Rivera <pat@example\.com>/s);
      expect(out.identity.source).toBe('supplied');
      expect(parseText(await confirmViaToken(h, other)).submitted).toBe(true);
      expect(submittedBody(requestSpy).body).toMatchObject({ email: 'sam@example.com' });
    });

    it('treats a case-only email difference as the same account', async () => {
      const { client } = makeClient();
      const out = parseText(
        await attachTool(client).get('signupgenius_rsvp')!({ ...BASE, email: 'Pat@Example.COM' }),
      ).preview;
      expect(out).not.toHaveProperty('identityDiffersFromAccount');
      expect(out.identity.source).toBe('mixed');
    });

    it('binds the token to the resolved identity', async () => {
      const { client, requestSpy, preSpy } = makeClient();
      const h = attachTool(client).get('signupgenius_rsvp')!;
      const phase1 = parseText(await h(BASE, TOKEN_CTX));
      const out = parseText(
        await h({ ...BASE, firstname: 'Sam', confirmToken: phase1.confirmToken }, TOKEN_CTX),
      );
      expect(out.error).toBe('DRAFT_CHANGED');
      expect(preSpy).not.toHaveBeenCalled();
      expect(requestSpy).not.toHaveBeenCalledWith('', expect.objectContaining({
        legacyAction: 's.processSignUpFormHandler',
      }));
    });

    it('refuses to default the identity when the profile has no email', async () => {
      const { client, preSpy } = makeClient(sessionAccount, [], { id: 1001, firstname: 'Pat', lastname: 'Rivera' });
      await expect(attachTool(client).get('signupgenius_rsvp')!(BASE)).rejects.toThrow(
        /Could not read email from your SignUpGenius profile/,
      );
      expect(preSpy).not.toHaveBeenCalled();
    });
  });

  it('rejects item-based RSVPs with a clear, scope-limiting error', async () => {
    // useRSVP===1 but rsvpdetails.rsvpitems has entries → the sign-up needs
    // per-item selections (lasagna vs salad, etc). This tool only takes a
    // headcount; building a useful payload for the item variant would need a
    // separate input surface, so we throw rather than silently submit a
    // truncated RSVP.
    const client = new SignUpGeniusClient(sessionAccount);
    vi.spyOn(client, 'request').mockImplementation(async (_p, opts) => {
      if (opts?.legacyAction === 's.getSignupInfo') {
        return { data: ITEM_RSVP_INFO, message: [], success: true } as never;
      }
      throw new Error('processSignUpFormHandler should not be called');
    });
    vi.spyOn(client, 'preProcessSignUp').mockResolvedValue(undefined);
    const handlers = attachTool(client);
    await expect(
      handlers.get('signupgenius_rsvp')!({
        url: URL_FULL, response: 'yes',
        firstname: 'A', lastname: 'B', email: 'x@y.co',
      }),
    ).rejects.toThrow(/item-based/i);
  });

  it('throws a clear error for non-RSVP (slot-based) sign-ups', async () => {
    const client = new SignUpGeniusClient(sessionAccount);
    vi.spyOn(client, 'request').mockImplementation(async (_p, opts) => {
      if (opts?.legacyAction === 's.getSignupInfo') {
        return { data: SLOT_INFO, message: [], success: true } as never;
      }
      throw new Error('processSignUpFormHandler should not be called');
    });
    vi.spyOn(client, 'preProcessSignUp').mockResolvedValue(undefined);
    const handlers = attachTool(client);
    await expect(
      handlers.get('signupgenius_rsvp')!({
        url: URL_FULL, response: 'yes', firstname: 'A', lastname: 'B', email: 'x@y.co',
      }),
    ).rejects.toThrow(/not an RSVP/i);
  });

  it('surfaces a server-side SUCCESS:false (thrown by the client) with RSVP context', async () => {
    // The real client never RESOLVES with success:false — parseEnvelope throws
    // `SignUpGenius error: <MESSAGE>` instead — so mock the shape it really
    // produces and check the tool rewraps it with RSVP context.
    const client = new SignUpGeniusClient(sessionAccount);
    vi.spyOn(client, 'request').mockImplementation(async (p, opts) => {
      if (p === '/signups/signedupfor') return { data: [], message: [], success: true } as never;
      if (opts?.legacyAction === 's.getSignupInfo') {
        return { data: RSVP_INFO, message: [], success: true } as never;
      }
      throw new Error('SignUpGenius error: Sign up failed.');
    });
    vi.spyOn(client, 'preProcessSignUp').mockResolvedValue(undefined);
    const handlers = attachTool(client);
    await expect(
      handlers.get('signupgenius_rsvp')!({
        url: URL_FULL, response: 'no', firstname: 'A', lastname: 'B', email: 'x@y.co',
      }, ACCEPT_CTX),
    ).rejects.toThrow(/RSVP submit failed: SignUpGenius error: Sign up failed\./);
  });

  it('warns against a blind resend when the submit throws and the re-read cannot tell (#234)', async () => {
    // A thrown submit may still have committed server-side; a resend creates
    // a second RSVP (rsvpid:0), so the error must not invite one.
    const client = new SignUpGeniusClient(sessionAccount);
    let listCalls = 0;
    vi.spyOn(client, 'request').mockImplementation(async (p, opts) => {
      if (p === '/signups/signedupfor') {
        listCalls++;
        if (listCalls > 1) throw new Error('HTTP 503');
        return { data: [], message: [], success: true } as never;
      }
      if (opts?.legacyAction === 's.getSignupInfo') {
        return { data: RSVP_INFO, message: [], success: true } as never;
      }
      throw new Error('HTTP 502');
    });
    vi.spyOn(client, 'preProcessSignUp').mockResolvedValue(undefined);
    const handlers = attachTool(client);
    const err = (await handlers
      .get('signupgenius_rsvp')!({
        url: URL_FULL, response: 'yes', firstname: 'A', lastname: 'B', email: 'x@y.co',
      }, ACCEPT_CTX)
      .catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/RSVP submit failed: HTTP 502/);
    expect(err.message).toMatch(/may still have been recorded/);
    expect(err.message).toMatch(/HTTP 503/);
    expect(err.message).toMatch(/signupgenius_list_signedupfor/);
  });

  it('refuses to RSVP again when the member already has a response on the sheet (#234)', async () => {
    const { client, requestSpy, preSpy } = makeClient(sessionAccount, [
      { signupid: 11111111, rsvpid: 0, signupitems: [] },
      { signupid: 63774883, rsvpid: 555, rsvpvalue: 'y', rsvpcount: 2, rsvpchildcount: 1 },
    ]);
    const handlers = attachTool(client);
    for (const ctx of [TOKEN_CTX, ACCEPT_CTX]) {
      await expect(
        handlers.get('signupgenius_rsvp')!({
          url: URL_FULL, response: 'no', firstname: 'A', lastname: 'B', email: 'x@y.co',
        }, ctx),
      ).rejects.toThrow(/already responded.*rsvpid 555/is);
    }
    expect(requestSpy).not.toHaveBeenCalledWith('', expect.objectContaining({
      legacyAction: 's.processSignUpFormHandler',
    }));
    // Refused before PreProcessSignup marks the sheet as being processed.
    expect(preSpy).not.toHaveBeenCalled();
  });

  it('ignores slot entries on the same sheet id that carry no RSVP', async () => {
    const { client } = makeClient(sessionAccount, [
      { signupid: 63774883, rsvpid: 0, rsvpvalue: '', signupitems: [] },
    ]);
    const handlers = attachTool(client);
    const result = (await handlers.get('signupgenius_rsvp')!({
      url: URL_FULL, response: 'yes', firstname: 'A', lastname: 'B', email: 'x@y.co',
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0].text).preview.duplicateCheck).toMatch(/no existing response/);
  });

  it('proceeds but says the duplicate check was skipped when signedupfor is unreadable', async () => {
    const { client } = makeClient(sessionAccount, { unexpected: 'shape' });
    const handlers = attachTool(client);
    const result = (await handlers.get('signupgenius_rsvp')!({
      url: URL_FULL, response: 'yes', firstname: 'A', lastname: 'B', email: 'x@y.co',
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0].text).preview.duplicateCheck).toMatch(/could not check/);
  });

  it('tells the caller NOT to resend when the failed submit actually landed (#234)', async () => {
    const client = new SignUpGeniusClient(sessionAccount);
    let listCalls = 0;
    vi.spyOn(client, 'request').mockImplementation(async (p, opts) => {
      if (p === '/signups/signedupfor') {
        listCalls++;
        const data = listCalls === 1 ? [] : [{ signupid: 63774883, rsvpid: 777, rsvpvalue: 'y' }];
        return { data, message: [], success: true } as never;
      }
      if (opts?.legacyAction === 's.getSignupInfo') {
        return { data: RSVP_INFO, message: [], success: true } as never;
      }
      throw new Error('HTTP 502');
    });
    vi.spyOn(client, 'preProcessSignUp').mockResolvedValue(undefined);
    const handlers = attachTool(client);
    await expect(
      handlers.get('signupgenius_rsvp')!({
        url: URL_FULL, response: 'yes', firstname: 'A', lastname: 'B', email: 'x@y.co',
      }, ACCEPT_CTX),
    ).rejects.toThrow(/IS now recorded.*do NOT resend/is);
  });

  it('reports a plain failure when the re-read shows no response landed', async () => {
    const client = new SignUpGeniusClient(sessionAccount);
    vi.spyOn(client, 'request').mockImplementation(async (p, opts) => {
      if (p === '/signups/signedupfor') return { data: [], message: [], success: true } as never;
      if (opts?.legacyAction === 's.getSignupInfo') {
        return { data: RSVP_INFO, message: [], success: true } as never;
      }
      throw new Error('HTTP 400 bad field');
    });
    vi.spyOn(client, 'preProcessSignUp').mockResolvedValue(undefined);
    const handlers = attachTool(client);
    const err = (await handlers.get('signupgenius_rsvp')!({
      url: URL_FULL, response: 'yes', firstname: 'A', lastname: 'B', email: 'x@y.co',
    }, ACCEPT_CTX).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/RSVP submit failed: HTTP 400 bad field/);
    expect(err.message).toMatch(/no response from you is listed/);
  });

  it('handles a non-Error submit rejection', async () => {
    const client = new SignUpGeniusClient(sessionAccount);
    vi.spyOn(client, 'request').mockImplementation(async (_p, opts) => {
      if (opts?.legacyAction === 's.getSignupInfo') {
        return { data: RSVP_INFO, message: [], success: true } as never;
      }
      throw 'plain-string failure';
    });
    vi.spyOn(client, 'preProcessSignUp').mockResolvedValue(undefined);
    const handlers = attachTool(client);
    await expect(
      handlers.get('signupgenius_rsvp')!({
        url: URL_FULL, response: 'yes', firstname: 'A', lastname: 'B', email: 'x@y.co',
      }, ACCEPT_CTX),
    ).rejects.toThrow(/RSVP submit failed: plain-string failure/);
  });

  it('rejects invalid URLs before any network call', async () => {
    const { client, requestSpy, preSpy } = makeClient();
    const handlers = attachTool(client);
    await expect(
      handlers.get('signupgenius_rsvp')!({
        url: 'not-a-slug', response: 'yes',
        firstname: 'A', lastname: 'B', email: 'x@y.co',
      }),
    ).rejects.toThrow();
    expect(preSpy).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
  });
});

// Real network-touching test for the client.preProcessSignUp side. We mock
// `globalThis.fetch` and confirm the right URL is hit with the right body and
// headers.
describe('SignUpGeniusClient.preProcessSignUp', () => {
  it('POSTs to /index.cfm with form-encoded body and the session auth headers', async () => {
    const client = new SignUpGeniusClient(sessionAccount, {
      refreshSession: async () => ({
        accessToken: 'JWT-XYZ',
        cookieHeader: 'cfid=1; cftoken=2; accessToken=JWT-XYZ',
      }),
    });
    const stub = vi.fn().mockResolvedValue({ ok: false, status: 301, headers: new Headers() });
    vi.stubGlobal('fetch', stub);
    await client.preProcessSignUp(SLUG);
    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = stub.mock.calls[0];
    expect(url).toBe(
      `https://www.signupgenius.com/index.cfm?go=s.PreProcessSignup&URLID=${SLUG}`,
    );
    expect(init.method).toBe('POST');
    expect(init.body).toContain('ScreenWidth=');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers.Authorization).toBe('Bearer JWT-XYZ');
    expect(init.headers.Cookie).toContain('cfid=1');
  });

  it('throws when the server returns an unexpected status', async () => {
    const client = new SignUpGeniusClient(sessionAccount, {
      refreshSession: async () => ({ accessToken: 'x', cookieHeader: 'y' }),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, headers: new Headers() }));
    await expect(client.preProcessSignUp(SLUG)).rejects.toThrow(/PreProcessSignup/);
  });

  it('refuses to run in key mode', async () => {
    const client = new SignUpGeniusClient(keyAccount);
    await expect(client.preProcessSignUp(SLUG)).rejects.toThrow(/session/i);
  });
});

describe('describeResponse', () => {
  it('names each response letter and defaults missing counts', () => {
    expect(describeResponse({ rsvpid: 1, rsvpvalue: 'Y', rsvpcount: 2, rsvpchildcount: 1 })).toBe(
      'rsvpid 1, response yes, 2 adult(s), 1 child(ren)',
    );
    expect(describeResponse({ rsvpid: 2, rsvpvalue: 'n' })).toMatch(/response no, 0 adult\(s\), 0 child/);
    expect(describeResponse({ rsvpid: 3, rsvpvalue: 'm' })).toMatch(/response maybe/);
    expect(describeResponse({})).toBe('rsvpid ?, response unknown, 0 adult(s), 0 child(ren)');
  });
});

describe('findOwnResponse', () => {
  function clientReturning(impl: () => Promise<unknown>) {
    const client = new SignUpGeniusClient(sessionAccount);
    vi.spyOn(client, 'request').mockImplementation(impl as never);
    return client;
  }

  it('matches a row by rsvpvalue alone when rsvpid is absent, skipping null rows', async () => {
    const client = clientReturning(async () => ({
      data: [null, { signupid: 63774883, rsvpvalue: 'm' }],
      message: [],
      success: true,
    }));
    expect(await findOwnResponse(client, 63774883)).toEqual({
      status: 'found',
      row: { signupid: 63774883, rsvpvalue: 'm' },
    });
  });

  it('reports a non-Error rejection as unknown', async () => {
    const client = clientReturning(async () => {
      throw 'boom';
    });
    expect(await findOwnResponse(client, 1)).toEqual({
      status: 'unknown',
      reason: 'signedupfor lookup failed: boom',
    });
  });
});
