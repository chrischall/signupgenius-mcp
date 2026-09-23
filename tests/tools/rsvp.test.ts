import { describe, it, expect, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { SignUpGeniusClient } from '../../src/client.js';
import { keyAccount, sessionAccount } from './_setup.js';
import {
  buildRsvpPayload,
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

function makeClient(account = sessionAccount, signedUpFor: unknown = []) {
  const client = new SignUpGeniusClient(account);
  const requestSpy = vi.spyOn(client, 'request').mockImplementation(async (path, opts) => {
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
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _c: unknown, cb: unknown) => {
    handlers.set(name, cb as (args: Record<string, unknown>) => Promise<unknown>);
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

  it('previews WITHOUT writing when confirm is absent', async () => {
    // Parity with claim_slot/release_slot: a real RSVP under the user's name
    // must never reach the organizer on the first call.
    const { client, requestSpy, preSpy } = makeClient();
    const handlers = attachTool(client);

    const result = (await handlers.get('signupgenius_rsvp')!({
      url: URL_FULL,
      response: 'yes',
      adults: 4,
      firstname: 'Chris',
      lastname: 'Hall',
      email: 'chris@example.com',
    })) as { content: Array<{ text: string }> };

    const out = JSON.parse(result.content[0].text);
    expect(out.submitted).toBe(false);
    expect(out.note).toMatch(/DRY RUN/);
    expect(out).toMatchObject({ response: 'yes', adults: 4, children: 0 });
    expect(out.respondingAs).toBe('Chris Hall <chris@example.com>');
    expect(out.duplicateCheck).toMatch(/no existing response/);
    // Only reads happened: no PreProcessSignup, no submit.
    expect(preSpy).not.toHaveBeenCalled();
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(requestSpy).toHaveBeenCalledWith('', {
      legacyAction: 's.getSignupInfo',
      body: { urlid: SLUG },
    });
    expect(requestSpy).toHaveBeenCalledWith('/signups/signedupfor');
    expect(requestSpy).not.toHaveBeenCalledWith('', expect.objectContaining({
      legacyAction: 's.processSignUpFormHandler',
    }));
  });

  it('treats confirm:false as a preview too', async () => {
    const { client, preSpy } = makeClient();
    const handlers = attachTool(client);
    const result = (await handlers.get('signupgenius_rsvp')!({
      url: URL_FULL, response: 'no', firstname: 'A', lastname: 'B', email: 'x@y.co', confirm: false,
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0].text).submitted).toBe(false);
    expect(preSpy).not.toHaveBeenCalled();
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
      confirm: true,
    })) as { content: Array<{ text: string }> };

    expect(preSpy).toHaveBeenCalledWith(SLUG);
    expect(requestSpy).toHaveBeenNthCalledWith(1, '', {
      legacyAction: 's.getSignupInfo',
      body: { urlid: SLUG },
    });
    expect(requestSpy).toHaveBeenNthCalledWith(2, '/signups/signedupfor');
    expect(requestSpy).toHaveBeenNthCalledWith(3, '', {
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

  it('surfaces a server-side failure as an error', async () => {
    const client = new SignUpGeniusClient(sessionAccount);
    vi.spyOn(client, 'request').mockImplementation(async (_p, opts) => {
      if (opts?.legacyAction === 's.getSignupInfo') {
        return { data: RSVP_INFO, message: [], success: true } as never;
      }
      return {
        data: {},
        message: ['Sign up failed.'],
        success: false,
      } as never;
    });
    vi.spyOn(client, 'preProcessSignUp').mockResolvedValue(undefined);
    const handlers = attachTool(client);
    await expect(
      handlers.get('signupgenius_rsvp')!({
        url: URL_FULL, response: 'no', firstname: 'A', lastname: 'B', email: 'x@y.co', confirm: true,
      }),
    ).rejects.toThrow(/Sign up failed|RSVP submit failed/i);
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
        url: URL_FULL, response: 'yes', firstname: 'A', lastname: 'B', email: 'x@y.co', confirm: true,
      })
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
    for (const confirm of [undefined, true]) {
      await expect(
        handlers.get('signupgenius_rsvp')!({
          url: URL_FULL, response: 'no', firstname: 'A', lastname: 'B', email: 'x@y.co', confirm,
        }),
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
    expect(JSON.parse(result.content[0].text).duplicateCheck).toMatch(/no existing response/);
  });

  it('proceeds but says the duplicate check was skipped when signedupfor is unreadable', async () => {
    const { client } = makeClient(sessionAccount, { unexpected: 'shape' });
    const handlers = attachTool(client);
    const result = (await handlers.get('signupgenius_rsvp')!({
      url: URL_FULL, response: 'yes', firstname: 'A', lastname: 'B', email: 'x@y.co',
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0].text).duplicateCheck).toMatch(/could not check/);
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
        url: URL_FULL, response: 'yes', firstname: 'A', lastname: 'B', email: 'x@y.co', confirm: true,
      }),
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
      url: URL_FULL, response: 'yes', firstname: 'A', lastname: 'B', email: 'x@y.co', confirm: true,
    }).catch((e: Error) => e)) as Error;
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
        url: URL_FULL, response: 'yes', firstname: 'A', lastname: 'B', email: 'x@y.co', confirm: true,
      }),
    ).rejects.toThrow(/RSVP submit failed: plain-string failure/);
  });

  it('falls back to "unknown" when the server failure has no detail', async () => {
    const client = new SignUpGeniusClient(sessionAccount);
    vi.spyOn(client, 'request').mockImplementation(async (_p, opts) => {
      if (opts?.legacyAction === 's.getSignupInfo') {
        return { data: RSVP_INFO, message: [], success: true } as never;
      }
      return { data: {}, message: [], success: false } as never;
    });
    vi.spyOn(client, 'preProcessSignUp').mockResolvedValue(undefined);
    const handlers = attachTool(client);
    await expect(
      handlers.get('signupgenius_rsvp')!({
        url: URL_FULL, response: 'maybe',
        firstname: 'A', lastname: 'B', email: 'x@y.co', confirm: true,
      }),
    ).rejects.toThrow(/unknown/i);
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
