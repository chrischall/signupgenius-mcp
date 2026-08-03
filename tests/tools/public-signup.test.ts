import { describe, it, expect, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  parseSignUpUrl,
  extractSignUpDetails,
  registerPublicSignUpTools,
  type Fetcher,
} from '../../src/tools/public-signup.js';

afterEach(() => vi.restoreAllMocks());

// A faithful (but trimmed) chunk of a real SignUpGenius /go/ page — enough
// markup that the regex-based extractor exercises every code path.
const FIXTURE_HTML = `
<!doctype html>
<html>
<head><title>Myers Park High School: Myers Park Bands Spring Banquet &amp; Awards Celebration</title></head>
<body>
<div class="SUGbold">Myers Park High School</div>
<h1 class="SUGHeaderText">Myers Park Bands Spring Banquet &amp; Awards Celebration</h1>
<p style="text-align:center">Join us for the annual Myers Park Bands Banquet &amp; Award Celebration before the final Symphonic and Wind Ensemble concert on Thursday, May 21st. Everyone is invited to celebrate our musicians!</p>
<p style="text-align:center"><strong>Please RSVP using this signup.</strong></p>
<strong>Date: </strong>05/21/2026 (Thu.)
<p></p>
<strong>Time:</strong> 5:00pm - 6:30pm CDT
<p></p>
<strong>Location: </strong>
Myers Park Cafeteria
<p></p>
<table class="creator-info">
<tr>
<td><strong>Created by:</strong>&nbsp;</td>
<td>&nbsp;Casey Payne</td>
</tr>
</table>
<td bgcolor="#008000" height="35" class="SUGtableheader">RSVP RESPONSES</td>
<strong class="SUGbigbold">Responses:</strong>
<span class="SUGmain">&nbsp;&nbsp;&nbsp; Yes: 61 &nbsp;&nbsp;&nbsp; No: 1 &nbsp;&nbsp;&nbsp; Maybe: 0 &nbsp;&nbsp;&nbsp;</span>
<strong class="SUGbigbold">Guest Count:</strong><span class="SUGmain">&nbsp;&nbsp;&nbsp; Confirmed: 148 &nbsp;&nbsp;&nbsp; Maybe: 0</span>
</body>
</html>
`;

describe('parseSignUpUrl', () => {
  it('accepts a full /go/ URL', () => {
    const p = parseSignUpUrl('https://www.signupgenius.com/go/10C054DA9AF2BA0FEC07-63774883-myers');
    expect(p).toEqual({
      urlid: '10C054DA9AF2BA0FEC07-63774883-myers',
      signupid: 63774883,
      vanity: 'myers',
      href: 'https://www.signupgenius.com/go/10C054DA9AF2BA0FEC07-63774883-myers',
    });
  });

  it('accepts a bare slug', () => {
    const p = parseSignUpUrl('10C054DA9AF2BA0FEC07-63774883-myers');
    expect(p.signupid).toBe(63774883);
    expect(p.vanity).toBe('myers');
  });

  it('accepts a slug without a vanity segment', () => {
    const p = parseSignUpUrl('ABCDEF0123-99999');
    expect(p.signupid).toBe(99999);
    expect(p.vanity).toBeUndefined();
    expect(p.href).toBe('https://www.signupgenius.com/go/ABCDEF0123-99999');
  });

  it('trims surrounding whitespace', () => {
    expect(parseSignUpUrl('  ABCDEF0123-1  ').signupid).toBe(1);
  });

  it('rejects unknown hosts', () => {
    expect(() => parseSignUpUrl('https://example.com/go/ABC-1-x')).toThrow(/SignUpGenius/);
  });

  it('rejects URLs without a /go/ path', () => {
    expect(() => parseSignUpUrl('https://www.signupgenius.com/index.cfm?x=1')).toThrow(/\/go\//);
  });

  it('rejects malformed slugs', () => {
    expect(() => parseSignUpUrl('not-a-slug')).toThrow(/sign-up URL/);
  });
});

describe('extractSignUpDetails', () => {
  const parts = parseSignUpUrl(
    'https://www.signupgenius.com/go/10C054DA9AF2BA0FEC07-63774883-myers',
  );

  it('extracts every advertised field from a full page', () => {
    const d = extractSignUpDetails(FIXTURE_HTML, parts);
    expect(d.urlid).toBe('10C054DA9AF2BA0FEC07-63774883-myers');
    expect(d.signupid).toBe(63774883);
    expect(d.vanity).toBe('myers');
    expect(d.url).toBe(parts.href);
    expect(d.title).toBe('Myers Park Bands Spring Banquet & Awards Celebration');
    expect(d.organization).toBe('Myers Park High School');
    expect(d.date).toBe('05/21/2026 (Thu.)');
    expect(d.time).toBe('5:00pm - 6:30pm CDT');
    expect(d.location).toBe('Myers Park Cafeteria');
    expect(d.creator).toBe('Casey Payne');
    expect(d.description.length).toBeGreaterThan(0);
    expect(d.description[0]).toMatch(/Join us for the annual Myers Park Bands Banquet/);
    expect(d.responses).toEqual({
      yes: 61,
      no: 1,
      maybe: 0,
      confirmedGuests: 148,
      maybeGuests: 0,
    });
  });

  it('returns a sparse object when the page has only a title', () => {
    const html = '<html><head><title>Just a title</title></head><body></body></html>';
    const d = extractSignUpDetails(html, parts);
    expect(d.title).toBe('Just a title');
    expect(d.organization).toBeUndefined();
    expect(d.date).toBeUndefined();
    expect(d.time).toBeUndefined();
    expect(d.location).toBeUndefined();
    expect(d.creator).toBeUndefined();
    expect(d.description).toEqual([]);
    expect(d.responses).toBeUndefined();
  });

  it('falls back to the page <title> when no h1.SUGHeaderText is present', () => {
    const html = '<html><head><title>Bare Title</title></head><body></body></html>';
    const d = extractSignUpDetails(html, parts);
    expect(d.title).toBe('Bare Title');
  });

  it('returns "Untitled sign-up" if neither h1 nor <title> is present', () => {
    expect(extractSignUpDetails('<html></html>', parts).title).toBe('Untitled sign-up');
  });

  it('omits partial response blocks when guest count is absent', () => {
    const html = '<span>Yes: 3 No: 2 Maybe: 1</span>';
    const d = extractSignUpDetails(html, parts);
    expect(d.responses).toEqual({ yes: 3, no: 2, maybe: 1 });
  });

  it('returns no creator when the creator-info table has only the label', () => {
    const html = `
      <table class="creator-info"><tr>
        <td><strong>Created by:</strong>&nbsp;</td>
        <td></td>
      </tr></table>
    `;
    expect(extractSignUpDetails(html, parts).creator).toBeUndefined();
  });

  it('decodes numeric HTML entities in extracted text', () => {
    const html = '<title>Smith &#38; Jones &#8212; Reunion</title>';
    expect(extractSignUpDetails(html, parts).title).toBe('Smith & Jones — Reunion');
  });

  it('drops empty <p> blocks from the description', () => {
    const html = `
      <h1 class="SUGHeaderText">Test</h1>
      <p></p>
      <p>Real paragraph.</p>
      <p>   </p>
      <strong>Date: </strong>01/01/2030
    `;
    const d = extractSignUpDetails(html, parts);
    expect(d.description).toEqual(['Real paragraph.']);
  });

  it('treats whitespace-only landmarks as missing', () => {
    const html = `
      <div class="SUGbold">   </div>
      <strong>Date: </strong>   <
      <strong>Time:</strong>   <
      <strong>Location: </strong>   <
    `;
    const d = extractSignUpDetails(html, parts);
    expect(d.organization).toBeUndefined();
    expect(d.date).toBeUndefined();
    expect(d.time).toBeUndefined();
    expect(d.location).toBeUndefined();
  });
});

function setupTool(fetcher: Fetcher) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _c: unknown, cb: unknown) => {
    handlers.set(name, cb as (args: Record<string, unknown>) => Promise<unknown>);
    return undefined as never;
  });
  registerPublicSignUpTools(server, fetcher);
  return handlers;
}

describe('signupgenius_get_public_signup tool', () => {
  it('fetches the canonical /go/ URL and returns extracted details', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => FIXTURE_HTML,
    });
    const handlers = setupTool(fetcher);
    const result = (await handlers.get('signupgenius_get_public_signup')!({
      url: 'https://www.signupgenius.com/go/10C054DA9AF2BA0FEC07-63774883-myers',
    })) as { content: Array<{ text: string }> };

    expect(fetcher).toHaveBeenCalledWith(
      'https://www.signupgenius.com/go/10C054DA9AF2BA0FEC07-63774883-myers',
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.title).toBe('Myers Park Bands Spring Banquet & Awards Celebration');
    expect(payload.signupid).toBe(63774883);
    expect(payload.responses.yes).toBe(61);
  });

  it('accepts a bare slug as input', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<title>x</title>',
    });
    const handlers = setupTool(fetcher);
    await handlers.get('signupgenius_get_public_signup')!({
      url: 'ABCDEF0123-99999-vanity',
    });
    expect(fetcher).toHaveBeenCalledWith('https://www.signupgenius.com/go/ABCDEF0123-99999-vanity');
  });

  it('surfaces HTTP errors with the status code', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '',
    });
    const handlers = setupTool(fetcher);
    await expect(
      handlers.get('signupgenius_get_public_signup')!({
        url: 'ABCDEF0123-99999',
      }),
    ).rejects.toThrow(/404/);
  });

  it('rejects invalid input before any fetch', async () => {
    const fetcher = vi.fn<Fetcher>();
    const handlers = setupTool(fetcher);
    await expect(
      handlers.get('signupgenius_get_public_signup')!({ url: 'not-a-slug' }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('defaults to global fetch when no fetcher is injected', async () => {
    const stub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<title>x</title>',
    });
    vi.stubGlobal('fetch', stub);
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, _c: unknown, cb: unknown) => {
      handlers.set(name, cb as (args: Record<string, unknown>) => Promise<unknown>);
      return undefined as never;
    });
    registerPublicSignUpTools(server);
    await handlers.get('signupgenius_get_public_signup')!({ url: 'ABC-1' });
    expect(stub).toHaveBeenCalledWith('https://www.signupgenius.com/go/ABC-1');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Angular-shell pages (the modern /go/ rendering)
// ────────────────────────────────────────────────────────────────────────────
//
// Verified 2026-08-02 against sign-up 62393618: the live /go/ page ships NO
// slot markup and no `h1.SUGHeaderText` under any User-Agent — it is a pure
// Angular shell whose <title> is the generic "Sign Me Up". The only real
// sheet metadata in the served HTML is the Open Graph block, which the
// original scraper ignored, so every modern sheet degraded to a title of
// "Sign Me Up" and an empty description.
const OG_SHELL_HTML = `
<!doctype html>
<html>
<head>
<title>Sign Me Up</title>
<meta property="og:title" content="2026-2027 Myers Park Marching Mustangs Chaperones" />
<meta property="og:description" content="We are looking forward to another great season! Chaperoning band events is a fun way to support our marchers." />
<meta property="og:image" content="https://s3.amazonaws.com/images.signupgenius.com/memberImages/abc_15465560.jpg" />
</head>
<body><div ng-app="SUGApp"></div></body>
</html>
`;

describe('extractSignUpDetails — Open Graph fallback', () => {
  const parts = parseSignUpUrl('10C0849AAAA2EA4FD0-62393618-20262027');

  it('prefers og:title over the generic <title> on an Angular-shell page', () => {
    const d = extractSignUpDetails(OG_SHELL_HTML, parts);
    expect(d.title).toBe('2026-2027 Myers Park Marching Mustangs Chaperones');
  });

  it('falls back to og:description when no <p> description block exists', () => {
    const d = extractSignUpDetails(OG_SHELL_HTML, parts);
    expect(d.description).toEqual([
      'We are looking forward to another great season! Chaperoning band events is a fun way to support our marchers.',
    ]);
  });

  it('surfaces og:image', () => {
    const d = extractSignUpDetails(OG_SHELL_HTML, parts);
    expect(d.image).toBe(
      'https://s3.amazonaws.com/images.signupgenius.com/memberImages/abc_15465560.jpg',
    );
  });

  it('still prefers the server-rendered h1 when the legacy markup IS present', () => {
    const d = extractSignUpDetails(FIXTURE_HTML, parseSignUpUrl('ABC-123'));
    expect(d.title).toBe('Myers Park Bands Spring Banquet & Awards Celebration');
    expect(d.image).toBeUndefined();
  });

  it('keeps the <p> description when both it and og:description exist', () => {
    const merged = FIXTURE_HTML.replace(
      '<head>',
      '<head><meta property="og:description" content="OG version" />',
    );
    const d = extractSignUpDetails(merged, parseSignUpUrl('ABC-123'));
    expect(d.description[0]).toMatch(/^Join us for the annual/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// signupgenius_get_signup_slots
// ────────────────────────────────────────────────────────────────────────────
//
// GET https://api.signupgenius.com/v3/signups/{id}/slots is fully
// unauthenticated (verified: byte-identical response with and without a valid
// session; a BOGUS Authorization header returns 500, so it must be called
// clean). This is the display feed the /go/ page renders from and the only
// read path for slots on a sheet the user does not own — the Pro
// /signups/report/* endpoints are both key-only AND owner-scoped.
const SLOTS_JSON = JSON.stringify({
  success: true,
  message: [],
  data: {
    slots: [
      {
        slotid: 464740348,
        title: 'Chaperone',
        hidenames: true,
        quantity: { limit: 6, unlimited: false },
        slotitems: [
          {
            slotitemid: 1762735194,
            quantity: { limit: 6, taken: 2, remaining: 4, unlimited: false, participantcount: 2 },
            availability: { signuplocked: false, addlocked: false, state: 'available' },
            participants: { itemmembers: [], totalcount: 0 },
            date: {
              starttime: '2026-08-21T17:00:00',
              endtime: '2026-08-21T22:00:00',
              location: { name: 'Providence Day', displaytext: 'Football Away @ Providence Day' },
            },
          },
          {
            slotitemid: 1762735188,
            quantity: { limit: 6, taken: 6, remaining: 0, unlimited: false, participantcount: 6 },
            availability: { signuplocked: false, addlocked: false, state: 'full' },
            participants: {
              itemmembers: [{ name: 'Casey Payne' }, { name: 'Alex Doe' }],
              totalcount: 2,
            },
            date: { starttime: '2026-09-26T00:00:00', endtime: null, location: null },
          },
        ],
      },
    ],
  },
});

describe('signupgenius_get_signup_slots tool', () => {
  it('calls the unauthenticated v3 slots endpoint with no auth headers', async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValue({ ok: true, status: 200, text: async () => SLOTS_JSON });
    const handlers = setupTool(fetcher);
    await handlers.get('signupgenius_get_signup_slots')!({
      url: 'https://www.signupgenius.com/go/10C0849AAAA2EA4FD0-62393618-20262027',
    });
    expect(fetcher).toHaveBeenCalledWith('https://api.signupgenius.com/v3/signups/62393618/slots');
    // Exactly one argument — no headers object. A bogus Authorization header
    // makes this endpoint 500, so it must be called clean.
    expect(fetcher.mock.calls[0]).toHaveLength(1);
  });

  it('accepts a bare numeric signup id as well as a slug', async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValue({ ok: true, status: 200, text: async () => SLOTS_JSON });
    const handlers = setupTool(fetcher);
    await handlers.get('signupgenius_get_signup_slots')!({ url: '62393618' });
    expect(fetcher).toHaveBeenCalledWith('https://api.signupgenius.com/v3/signups/62393618/slots');
  });

  it('flattens slots into slot items with dates, locations and counts', async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValue({ ok: true, status: 200, text: async () => SLOTS_JSON });
    const handlers = setupTool(fetcher);
    const res = (await handlers.get('signupgenius_get_signup_slots')!({ url: '62393618' })) as {
      content: Array<{ text: string }>;
    };
    const out = JSON.parse(res.content[0].text);
    expect(out.signupid).toBe(62393618);
    expect(out.totalRemaining).toBe(4);
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({
      slot: 'Chaperone',
      slotitemid: 1762735194,
      starttime: '2026-08-21T17:00:00',
      location: 'Football Away @ Providence Day',
      taken: 2,
      limit: 6,
      remaining: 4,
      state: 'available',
    });
    expect(out.items[1]).toMatchObject({ state: 'full', remaining: 0 });
    // No location on this slot item — the key is omitted rather than null.
    expect('location' in out.items[1]).toBe(false);
  });

  it('exposes participant names when the sheet does not hide them', async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValue({ ok: true, status: 200, text: async () => SLOTS_JSON });
    const handlers = setupTool(fetcher);
    const res = (await handlers.get('signupgenius_get_signup_slots')!({ url: '62393618' })) as {
      content: Array<{ text: string }>;
    };
    const out = JSON.parse(res.content[0].text);
    // hidenames:true on this slot — names are withheld by the OWNER's display
    // setting, not by a permission boundary, so we report the flag rather than
    // implying the caller lacks access.
    expect(out.items[0].hidenames).toBe(true);
    expect(out.items[1].participants).toEqual(['Casey Payne', 'Alex Doe']);
  });

  it('maps a 404 to an actionable error', async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValue({ ok: false, status: 404, text: async () => '{"success":false}' });
    const handlers = setupTool(fetcher);
    await expect(handlers.get('signupgenius_get_signup_slots')!({ url: '999999999' })).rejects.toThrow(
      /no sign-up with id 999999999/i,
    );
  });

  it('throws when the endpoint returns success:false', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"success":false,"message":["nope"]}',
    });
    const handlers = setupTool(fetcher);
    await expect(handlers.get('signupgenius_get_signup_slots')!({ url: '1' })).rejects.toThrow(/nope/);
  });

  it('throws on a non-JSON body', async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValue({ ok: true, status: 200, text: async () => '<html>nope</html>' });
    const handlers = setupTool(fetcher);
    await expect(handlers.get('signupgenius_get_signup_slots')!({ url: '1' })).rejects.toThrow(
      /non-JSON/i,
    );
  });

  it('handles a sheet with no slots', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"success":true,"data":{"slots":[]}}',
    });
    const handlers = setupTool(fetcher);
    const res = (await handlers.get('signupgenius_get_signup_slots')!({ url: '1' })) as {
      content: Array<{ text: string }>;
    };
    const out = JSON.parse(res.content[0].text);
    expect(out.items).toEqual([]);
    expect(out.totalRemaining).toBe(0);
  });

  it('defaults the fetcher to globalThis.fetch', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(SLOTS_JSON, { status: 200 }));
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const handlers = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, _c: unknown, cb: unknown) => {
      handlers.set(name, cb as (a: Record<string, unknown>) => Promise<unknown>);
      return undefined as never;
    });
    registerPublicSignUpTools(server);
    await handlers.get('signupgenius_get_signup_slots')!({ url: '62393618' });
    expect(spy).toHaveBeenCalledWith('https://api.signupgenius.com/v3/signups/62393618/slots');
  });
});

describe('slots — edge shapes and defensive fallbacks', () => {
  const fetcherFor = (json: string, init: { ok?: boolean; status?: number } = {}) =>
    vi.fn<Fetcher>().mockResolvedValue({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      text: async () => json,
    });

  it('maps a non-404 HTTP failure to a plain error', async () => {
    const handlers = setupTool(fetcherFor('', { ok: false, status: 503 }));
    await expect(handlers.get('signupgenius_get_signup_slots')!({ url: '1' })).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it('reports "unknown" when success:false carries no message', async () => {
    const handlers = setupTool(fetcherFor('{"success":false}'));
    await expect(handlers.get('signupgenius_get_signup_slots')!({ url: '1' })).rejects.toThrow(
      /unknown/,
    );
  });

  it('tolerates a slots envelope with missing optional fields', async () => {
    // Every field the real API has sent has been optional at some point in
    // recon; the flattener must not throw on a sparse item.
    const sparse = JSON.stringify({
      success: true,
      data: { slots: [{ slotitems: [{}] }] },
    });
    const handlers = setupTool(fetcherFor(sparse));
    const res = (await handlers.get('signupgenius_get_signup_slots')!({ url: '1' })) as {
      content: Array<{ text: string }>;
    };
    const out = JSON.parse(res.content[0].text);
    expect(out.items[0]).toMatchObject({
      slot: '(untitled slot)',
      slotid: 0,
      slotitemid: 0,
      starttime: null,
      endtime: null,
      limit: null,
      taken: 0,
      remaining: null,
      unlimited: false,
      hidenames: false,
    });
    expect(out.totalRemaining).toBe(0);
  });

  it('handles a slot with no slotitems array and a data block with no slots', async () => {
    const handlers = setupTool(
      fetcherFor(JSON.stringify({ success: true, data: { slots: [{ title: 'x' }] } })),
    );
    const res = (await handlers.get('signupgenius_get_signup_slots')!({ url: '1' })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(res.content[0].text).items).toEqual([]);

    const handlers2 = setupTool(fetcherFor(JSON.stringify({ success: true, data: {} })));
    const res2 = (await handlers2.get('signupgenius_get_signup_slots')!({ url: '1' })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(res2.content[0].text).items).toEqual([]);
  });

  it('falls back to location.name when displaytext is absent', async () => {
    const json = JSON.stringify({
      success: true,
      data: {
        slots: [
          {
            title: 'S',
            slotitems: [
              { date: { location: { name: 'Band Room', displaytext: null } } },
              { date: { location: {} } },
            ],
          },
        ],
      },
    });
    const handlers = setupTool(fetcherFor(json));
    const res = (await handlers.get('signupgenius_get_signup_slots')!({ url: '1' })) as {
      content: Array<{ text: string }>;
    };
    const items = JSON.parse(res.content[0].text).items;
    expect(items[0].location).toBe('Band Room');
    expect('location' in items[1]).toBe(false);
  });

  it('drops nameless participant entries rather than emitting empty strings', async () => {
    const json = JSON.stringify({
      success: true,
      data: {
        slots: [
          {
            title: 'S',
            slotitems: [{ participants: { itemmembers: [{ name: '' }, { anon: true }] } }],
          },
        ],
      },
    });
    const handlers = setupTool(fetcherFor(json));
    const res = (await handlers.get('signupgenius_get_signup_slots')!({ url: '1' })) as {
      content: Array<{ text: string }>;
    };
    expect('participants' in JSON.parse(res.content[0].text).items[0]).toBe(false);
  });

  it('rejects an unparseable slug that is not a bare id', async () => {
    const handlers = setupTool(fetcherFor('{}'));
    await expect(
      handlers.get('signupgenius_get_signup_slots')!({ url: 'not-a-real-slug!!' }),
    ).rejects.toThrow(/Not a valid SignUpGenius/);
  });
});

describe('ogTag attribute-order tolerance', () => {
  it('reads og:title when content precedes property', () => {
    const html = '<meta content="Reversed Order Sheet" property="og:title" />';
    const d = extractSignUpDetails(html, parseSignUpUrl('ABC-9'));
    expect(d.title).toBe('Reversed Order Sheet');
  });

  it('ignores an empty og:title and falls through to <title>', () => {
    const html = '<meta property="og:title" content="  " /><title>Real Title</title>';
    const d = extractSignUpDetails(html, parseSignUpUrl('ABC-9'));
    expect(d.title).toBe('Real Title');
  });

  it('returns the placeholder title when the page has nothing at all', () => {
    const d = extractSignUpDetails('<html></html>', parseSignUpUrl('ABC-9'));
    expect(d.title).toBe('Untitled sign-up');
    expect(d.description).toEqual([]);
  });
});

describe('slots — unlimited capacity accounting', () => {
  // Folding unlimited items in as `remaining: 0` made an all-unlimited sheet
  // report `totalRemaining: 0`, which reads as "full" when it is the exact
  // opposite. A sum cannot represent "no ceiling", so the count is carried
  // separately rather than encoded into the total.
  const unlimitedJson = JSON.stringify({
    success: true,
    data: {
      slots: [
        {
          title: 'Bring a dish',
          slotitems: [
            { slotitemid: 1, quantity: { limit: null, taken: 3, remaining: null, unlimited: true } },
            { slotitemid: 2, quantity: { limit: null, taken: 0, remaining: null, unlimited: true } },
          ],
        },
      ],
    },
  });

  const run = async (json: string) => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValue({ ok: true, status: 200, text: async () => json });
    const handlers = setupTool(fetcher);
    const res = (await handlers.get('signupgenius_get_signup_slots')!({ url: '1' })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(res.content[0].text);
  };

  it('does not report an all-unlimited sheet as if it were full', async () => {
    const out = await run(unlimitedJson);
    expect(out.slotCount).toBe(2);
    expect(out.unlimitedSlots).toBe(2);
    // 0 finite remaining, but that must not be read as "nothing available".
    expect(out.totalRemaining).toBe(0);
  });

  it('sums only the finite items on a mixed sheet', async () => {
    const mixed = JSON.stringify({
      success: true,
      data: {
        slots: [
          {
            title: 'Mixed',
            slotitems: [
              { slotitemid: 1, quantity: { limit: 6, taken: 2, remaining: 4, unlimited: false } },
              { slotitemid: 2, quantity: { limit: null, taken: 9, remaining: null, unlimited: true } },
            ],
          },
        ],
      },
    });
    const out = await run(mixed);
    expect(out.totalRemaining).toBe(4);
    expect(out.unlimitedSlots).toBe(1);
  });
});
