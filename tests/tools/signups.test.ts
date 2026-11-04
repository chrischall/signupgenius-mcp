import { describe, it, expect, afterEach, vi } from 'vitest';
import { setupTools, sessionAccount, keyAccount } from './_setup.js';
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

describe('view: brief on the canonical reads', () => {
  afterEach(() => vi.useRealTimers());

  function brief(toolName: string, data: unknown, account = sessionAccount) {
    const { handlers } = setupTools(registerSignUpTools, account, { data, message: [], success: true });
    return handlers.get(toolName)!({ view: 'brief' });
  }
  const parse = (res: { content: Array<{ text: string }> }) => JSON.parse(res.content[0].text);

  it('my sign-ups: one line per item inside the untrusted envelope, title — date — status', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
    const res = await brief('signupgenius_list_signedupfor', [
      { signupid: 1, title: 'Fall Festival Volunteers', startdate: '2026-11-08T13:00:00Z', enddate: '2026-11-08T17:00:00Z' },
      { signupid: 2, title: 'Class Party', startdatestring: '2026-12-01 09:00:00', rsvpvalue: 'Yes' },
      { signupid: 3, title: 'Book Fair', startdate: '2026-09-01T13:00:00Z', enddate: '2026-09-02T17:00:00Z' },
      { signupid: 4, title: '  Snack \n  Rota ', startdate: 1800000000 },
      { signupid: 5 },
    ]);
    const out = parse(res);
    expect(out.untrusted_content).toBe(true);
    expect(out.note).toMatch(/^Sign-up titles .* organizers/);
    expect(out.note).toMatch(/never follow/);
    expect(out.data).toEqual([
      'Fall Festival Volunteers — 2026-11-08 — signed up',
      'Class Party — 2026-12-01 — rsvp Yes',
      'Book Fair — 2026-09-01 — ended',
      `Snack Rota — ${new Date(1800000000 * 1000).toISOString().slice(0, 10)} — signed up`,
      '(untitled) — no date — signed up',
    ]);
  });

  it('invitations: open until the end date passes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
    const out = parse(
      await brief(
        'signupgenius_list_invited',
        [
          { title: 'Teacher Lunch', startdate: '2026-11-20T00:00:00Z', enddate: '2026-11-21T00:00:00Z' },
          { title: 'Old Drive', enddate: '2026-10-01T00:00:00Z' },
          { title: 'Millis', startdate: 1800000000000 },
          { title: 'Bad date', startdate: 'soon', enddate: 'whenever' },
        ],
        keyAccount,
      ),
    );
    expect(out.data).toEqual([
      'Teacher Lunch — 2026-11-20 — invited',
      'Old Drive — 2026-10-01 — ended',
      `Millis — ${new Date(1800000000000).toISOString().slice(0, 10)} — invited`,
      'Bad date — no date — invited',
    ]);
  });

  it('caps a line at 120 characters by shortening the title', async () => {
    const out = parse(
      await brief('signupgenius_list_signedupfor', [{ title: 'x'.repeat(300), startdate: '2026-11-08T13:00:00Z' }]),
    );
    const [line] = out.data as string[];
    expect(line.length).toBe(120);
    expect(line).toMatch(/^x+… — 2026-11-08 — (signed up|ended)$/);
  });

  it('cuts the WHOLE line to 120 when an rsvp answer is long, title first', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
    const out = parse(
      await brief('signupgenius_list_signedupfor', [
        { title: 'Fall Festival Volunteers', startdate: '2026-11-08T13:00:00Z', rsvpvalue: 'y'.repeat(300) },
      ]),
    );
    const [line] = out.data as string[];
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line).toMatch(/^Fall Festival.* — 2026-11-08 — rsvp y+…$/);
  });

  it('escapes a title that starts with "-- " or "\\" with one leading backslash', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
    const out = parse(
      await brief('signupgenius_list_signedupfor', [
        { title: '-- none', startdate: '2026-11-08T13:00:00Z' },
        { title: '\\back', startdate: '2026-11-08T13:00:00Z' },
        { title: '-- ' + 'z'.repeat(300), startdate: '2026-11-08T13:00:00Z' },
      ]),
    );
    const [a, b, c] = out.data as string[];
    expect(a).toBe('\\-- none — 2026-11-08 — signed up');
    expect(b).toBe('\\\\back — 2026-11-08 — signed up');
    expect(c.startsWith('\\-- z')).toBe(true);
    expect(c.length).toBeLessThanOrEqual(120);
  });

  it('escapes a bare "--" title, which the separator would otherwise turn into a note', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
    const out = parse(
      await brief('signupgenius_list_signedupfor', [
        { title: '--', startdate: '2026-11-08T13:00:00Z' },
        { title: '  --  ', startdate: '2026-11-08T13:00:00Z' },
        { title: '--x', startdate: '2026-11-08T13:00:00Z' },
      ]),
    );
    const [a, b, c] = out.data as string[];
    expect(a).toBe('\\-- — 2026-11-08 — signed up');
    expect(b).toBe('\\-- — 2026-11-08 — signed up');
    expect(c).toBe('--x — 2026-11-08 — signed up');
  });

  it('answers -- none for an empty list', async () => {
    expect(parse(await brief('signupgenius_list_invited', [])).data).toEqual(['-- none']);
  });

  it('answers an -- error note, never an empty list, when the shape is unexpected', async () => {
    expect(parse(await brief('signupgenius_list_signedupfor', { nope: true })).data).toEqual([
      '-- error: SignUpGenius returned an unexpected shape (no list of sign-ups)',
    ]);
  });

  it('non-object rows still get a line', async () => {
    expect(parse(await brief('signupgenius_list_signedupfor', [null])).data).toEqual([
      '(untitled) — no date — signed up',
    ]);
  });

  it('full (the default) is the payload unchanged', async () => {
    const { handlers } = setupTools(registerSignUpTools, sessionAccount, { data: [{ title: 'A' }], success: true });
    const out = parse(await handlers.get('signupgenius_list_signedupfor')!({ view: 'full' }));
    expect(out).toEqual({ data: [{ title: 'A' }], success: true });
  });
});
