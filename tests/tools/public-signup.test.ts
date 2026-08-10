import { describe, it, expect, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  parseSignUpUrl,
  toSignUpDetails,
  toCustomFields,
  fetchSignupInfo,
  registerPublicSignUpTool,
  type Fetcher,
} from '../../src/tools/public-signup.js';
import INFO from '../fixtures/signupinfo.json' with { type: 'json' };

afterEach(() => vi.restoreAllMocks());

const PARTS = parseSignUpUrl('10C0849AAAA2EA4FD0-62393618-20262027');

/** Fetcher stub returning the upper-case legacy envelope. */
function envelopeFetcher(data: unknown, opts: { success?: boolean; message?: string[] } = {}) {
  const calls: Array<{ url: string; init?: unknown }> = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ MESSAGE: opts.message ?? [], DATA: data, SUCCESS: opts.success ?? true }),
    };
  };
  return { fetcher, calls };
}

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

  it('accepts a bare slug and one without a vanity suffix', () => {
    expect(parseSignUpUrl('10C054DA9AF2BA0FEC07-63774883-myers').signupid).toBe(63774883);
    expect(parseSignUpUrl('ABC123-999').vanity).toBeUndefined();
  });

  it('rejects non-SignUpGenius URLs, non-/go/ paths, and junk slugs', () => {
    expect(() => parseSignUpUrl('https://example.com/go/A-1')).toThrow(/Not a SignUpGenius URL/);
    expect(() => parseSignUpUrl('https://www.signupgenius.com/find')).toThrow(/no \/go\/ path/);
    expect(() => parseSignUpUrl('nonsense')).toThrow(/Not a valid SignUpGenius/);
  });
});

describe('toSignUpDetails (real captured s.getSignupInfo payload)', () => {
  const out = toSignUpDetails(INFO as never, PARTS);

  it('returns the REAL sheet title, not the page shell title', () => {
    // The old HTML scraper returned "Sign Me Up" here — the Angular shell's
    // constant <title>. This is the regression that motivated the rewrite.
    expect(out.title).toBe('2026-2027 Myers Park Marching Mustangs Chaperones');
    expect(out.title).not.toBe('Sign Me Up');
  });

  it('returns the description as decoded plain-text paragraphs', () => {
    expect(out.description.length).toBeGreaterThan(1);
    expect(out.description[0]).toContain('another great season');
    // Entities decoded, tags stripped, nbsp normalised.
    expect(out.description[0]).toContain("band's inner workings");
    expect(out.description.join(' ')).not.toMatch(/<p|&#39;|&nbsp;/);
  });

  it('maps organization, category, creator and timezone', () => {
    expect(out.organization).toBe('MPMM 26-27');
    expect(out.organizationId).toBe(25532797);
    expect(out.category).toBe('Volunteering');
    expect(out.format).toBe('Standard');
    expect(out.creator).toBe('Robin Hale');
    expect(out.creatorEmail).toBe('organizer@example.com');
    expect(out.creatorId).toBe(15465560);
    expect(out.timezone).toBe('EDT');
    expect(out.created).toMatch(/February, 16 2026/);
  });

  it('flags the sheet as slot-based, not RSVP', () => {
    expect(out.isRsvp).toBe(false);
    expect(out.accountRequired).toBe(false);
  });

  it('surfaces the required custom fields a claim must satisfy', () => {
    expect(out.customFields).toEqual([
      { type: 'PhoneType', name: 'PhoneType', required: true, options: ['Home', 'Mobile', 'Work'] },
      { type: 'Phone', name: 'Phone', required: true },
    ]);
  });

  it('drops the bare theme-directory image placeholder', () => {
    // signupimage is ".../images/theme/" when the sheet has no banner.
    expect(out.image).toBeUndefined();
  });
});

describe('toSignUpDetails fallbacks', () => {
  it('falls back to slug-derived id/url and a placeholder title', () => {
    const out = toSignUpDetails({}, PARTS);
    expect(out.signupid).toBe(62393618);
    expect(out.url).toBe(PARTS.href);
    expect(out.title).toBe('Untitled sign-up');
    expect(out.description).toEqual([]);
    expect(out.customFields).toBeUndefined();
    expect(out.vanity).toBe('20262027');
  });

  it('uses contactname when owner first/last are absent, and keeps a real image', () => {
    const out = toSignUpDetails(
      { contactname: 'Casey Payne', signupimage: 'https://x/img/banner.png', useRSVP: 1, accountRequired: 1 },
      PARTS,
    );
    expect(out.creator).toBe('Casey Payne');
    expect(out.image).toBe('https://x/img/banner.png');
    expect(out.isRsvp).toBe(true);
    expect(out.accountRequired).toBe(true);
  });

  it('omits vanity when the slug has none', () => {
    expect(toSignUpDetails({}, parseSignUpUrl('ABC-1')).vanity).toBeUndefined();
  });
});

describe('description HTML conversion', () => {
  it('decodes numeric entities and splits <p> blocks into paragraphs', () => {
    const out = toSignUpDetails(
      { description: '<p>Caf&#233; night &#8212; bring a friend</p><p>Second&nbsp;block</p>' },
      PARTS,
    );
    expect(out.description).toEqual(['Café night — bring a friend', 'Second block']);
  });
});

describe('toCustomFields', () => {
  it('returns [] for a non-array', () => {
    expect(toCustomFields(undefined)).toEqual([]);
  });

  it('defaults type and required, and omits empty option lists', () => {
    expect(toCustomFields([{}])).toEqual([{ type: 'Text', required: false }]);
  });

  it('reads options in either key casing', () => {
    const [f] = toCustomFields([
      {
        fieldtype: 'Select',
        fieldvalues: [
          { optionname: 'lower', optionval: 'a' },
          { OPTIONNAME: 'UPPER', OPTIONVAL: 'b' },
        ],
      },
    ]);
    expect(f.options).toEqual(['lower', 'UPPER']);
  });

  it('ignores option rows with no submit value and non-string names', () => {
    const [f] = toCustomFields([
      {
        fieldtype: 'Select',
        fieldvalues: [
          { optionname: 'Placeholder', optionval: '' },
          { optionname: 'NoValueKeyAtAll' },
          { optionval: 'x' },
          { optionname: 42, optionval: 'y' },
        ],
      },
    ]);
    expect(f.options).toBeUndefined();
  });
});

describe('fetchSignupInfo', () => {
  it('POSTs JSON to the getSignupInfo action with no credentials', async () => {
    const { fetcher, calls } = envelopeFetcher({ id: 1 });
    await fetchSignupInfo(fetcher, 'SLUG-1');
    expect(calls[0].url).toBe('https://www.signupgenius.com/SUGboxAPI.cfm?go=s.getSignupInfo');
    const init = calls[0].init as { method: string; body: string; headers: Record<string, string> };
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ urlid: 'SLUG-1' });
    // No Cookie / Authorization: this endpoint is public and a bogus
    // credential is what breaks sibling endpoints.
    expect(Object.keys(init.headers)).toEqual(['Content-Type', 'Accept']);
  });

  it('throws on HTTP failure, non-JSON bodies, and SUCCESS:false', async () => {
    const bad: Fetcher = async () => ({ ok: false, status: 500, text: async () => '' });
    await expect(fetchSignupInfo(bad, 'S')).rejects.toThrow(/HTTP 500/);

    const html: Fetcher = async () => ({ ok: true, status: 200, text: async () => '<html>' });
    await expect(fetchSignupInfo(html, 'S')).rejects.toThrow(/non-JSON body/);

    const { fetcher } = envelopeFetcher(null, { success: false, message: ['Nope <a href="x">here</a>'] });
    await expect(fetchSignupInfo(fetcher, 'S')).rejects.toThrow(/Nope here/);
  });

  it('reports "unknown" when a failure carries no message', async () => {
    const { fetcher } = envelopeFetcher(null, { success: false, message: [] });
    await expect(fetchSignupInfo(fetcher, 'S')).rejects.toThrow(/unknown/);
  });

  it('handles a MESSAGE sent as a bare string', async () => {
    const f: Fetcher = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ MESSAGE: 'boom', SUCCESS: false }),
    });
    await expect(fetchSignupInfo(f, 'S')).rejects.toThrow(/boom/);
  });

  it('handles a missing MESSAGE key', async () => {
    const f: Fetcher = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ SUCCESS: false }),
    });
    await expect(fetchSignupInfo(f, 'S')).rejects.toThrow(/unknown/);
  });
});

describe('signupgenius_get_public_signup tool', () => {
  function setup(fetcher: Fetcher) {
    const server = new McpServer({ name: 't', version: '0' });
    const handlers = new Map<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
    vi.spyOn(server, 'registerTool').mockImplementation((n: string, _c: unknown, cb: unknown) => {
      handlers.set(n, cb as never);
      return undefined as never;
    });
    registerPublicSignUpTool(server, fetcher);
    return handlers;
  }

  it('returns the mapped envelope', async () => {
    const { fetcher } = envelopeFetcher(INFO);
    const h = setup(fetcher).get('signupgenius_get_public_signup')!;
    const res = await h({ url: 'https://www.signupgenius.com/go/10C0849AAAA2EA4FD0-62393618-20262027' });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.title).toBe('2026-2027 Myers Park Marching Mustangs Chaperones');
    expect(parsed.signupid).toBe(62393618);
  });

  it('defaults to the real global fetch when no fetcher is injected', () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ SUCCESS: true, DATA: {}, MESSAGE: [] }),
    } as never);
    const server = new McpServer({ name: 't', version: '0' });
    const handlers = new Map<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
    vi.spyOn(server, 'registerTool').mockImplementation((n: string, _c: unknown, cb: unknown) => {
      handlers.set(n, cb as never);
      return undefined as never;
    });
    registerPublicSignUpTool(server);
    return handlers.get('signupgenius_get_public_signup')!({ url: 'ABC-1' }).then(() => {
      expect(spy).toHaveBeenCalled();
    });
  });
});
