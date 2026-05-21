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
