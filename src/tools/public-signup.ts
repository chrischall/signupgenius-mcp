import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textContent } from './_shared.js';

/**
 * Public-signup tool.
 *
 * Any SignUpGenius sign-up has a public URL of the shape
 * `https://www.signupgenius.com/go/<urlid>-<signupid>[-<vanity>]`. The page
 * itself is server-rendered HTML — there is no JSON surface that returns the
 * same data, so this tool fetches the page and scrapes the well-known
 * landmarks (`h1.SUGHeaderText`, the Date/Time/Location strong tags, the RSVP
 * Responses table) into a structured envelope.
 *
 * No SignUpGenius credentials are required: the /go/ URL is publicly viewable
 * by anyone with the link. This is why the tool is registered unconditionally
 * in `src/index.ts`, even when `resolveAuth()` produced a deferred config
 * error. Behind the scenes the tool calls `globalThis.fetch` directly — it
 * does NOT route through `SignUpGeniusClient`, since the client is tied to
 * the v2/v3 JSON envelopes.
 */

/** Minimum surface of a fetch response we use — `text()` + status. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type Fetcher = (url: string) => Promise<FetchResponseLike>;

export interface SignUpUrlParts {
  /** The full slug, e.g. `10C054DA9AF2BA0FEC07-63774883-myers`. */
  urlid: string;
  /** The numeric sign-up ID from the middle segment. */
  signupid: number;
  /** The optional vanity suffix, lower-cased. `undefined` when absent. */
  vanity: string | undefined;
  /** Canonical https URL for the sign-up page. */
  href: string;
}

export interface SignUpDetails {
  urlid: string;
  signupid: number;
  vanity?: string;
  url: string;
  title: string;
  organization?: string;
  date?: string;
  time?: string;
  location?: string;
  description: string[];
  creator?: string;
  responses?: {
    yes?: number;
    no?: number;
    maybe?: number;
    confirmedGuests?: number;
    maybeGuests?: number;
  };
}

const inputSchema = z.object({
  url: z
    .string()
    .min(1)
    .describe(
      'Either a full SignUpGenius sign-up URL (e.g. https://www.signupgenius.com/go/<slug>) ' +
        'or just the slug. The slug looks like `<hex>-<signupid>[-<vanity>]`.',
    ),
});

/** Parse the input into structured URL parts. Throws on anything unparseable. */
export function parseSignUpUrl(input: string): SignUpUrlParts {
  const slug = extractSlug(input.trim());
  // Slug shape: `<hex>-<digits>[-<vanity>]`. We accept any uppercase/lowercase
  // alphanum for the first segment because SignUpGenius mixes hex and base32
  // tokens at different vintages.
  const match = slug.match(/^([A-Za-z0-9]+)-(\d+)(?:-([A-Za-z0-9]+))?$/);
  if (!match) {
    throw new Error(
      `Not a valid SignUpGenius sign-up URL or slug: ${input}. ` +
        'Expected the form `<urlid>-<signupid>[-<vanity>]`.',
    );
  }
  return {
    urlid: slug,
    signupid: Number(match[2]),
    vanity: match[3] ? match[3].toLowerCase() : undefined,
    href: `https://www.signupgenius.com/go/${slug}`,
  };
}

function extractSlug(input: string): string {
  if (/^https?:\/\//i.test(input)) {
    if (!/(^|\.)signupgenius\.com\//i.test(input)) {
      throw new Error(`Not a SignUpGenius URL: ${input}`);
    }
    const m = input.match(/\/go\/([A-Za-z0-9-]+)/);
    if (!m) {
      throw new Error(
        `SignUpGenius URL has no /go/ path segment: ${input}. ` +
          'Only public sign-up sheets (signupgenius.com/go/<slug>) are supported.',
      );
    }
    return m[1];
  }
  return input;
}

/** Scrape the public /go/ page HTML into a structured envelope. */
export function extractSignUpDetails(html: string, parts: SignUpUrlParts): SignUpDetails {
  const out: SignUpDetails = {
    urlid: parts.urlid,
    signupid: parts.signupid,
    url: parts.href,
    title: pickTitle(html),
    description: extractDescription(html),
  };
  if (parts.vanity !== undefined) out.vanity = parts.vanity;

  const organization = textOf(html, /<div class="SUGbold">([\s\S]*?)<\/div>/);
  if (organization) out.organization = organization;

  const date = textAfterStrong(html, 'Date');
  if (date) out.date = date;

  const time = textAfterStrong(html, 'Time');
  if (time) out.time = time;

  const location = textAfterStrong(html, 'Location');
  if (location) out.location = location;

  const creator = extractCreator(html);
  if (creator) out.creator = creator;

  const responses = extractResponses(html);
  if (responses) out.responses = responses;

  return out;
}

function pickTitle(html: string): string {
  const h1 = textOf(html, /<h1 class="SUGHeaderText">([\s\S]*?)<\/h1>/);
  if (h1) return h1;
  const t = textOf(html, /<title>([\s\S]*?)<\/title>/i);
  if (t) return t;
  return 'Untitled sign-up';
}

function extractDescription(html: string): string[] {
  const m = html.match(/<h1 class="SUGHeaderText">[\s\S]*?<\/h1>([\s\S]*?)<strong>Date/);
  if (!m) return [];
  const paragraphs: string[] = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/g;
  let p: RegExpExecArray | null;
  while ((p = re.exec(m[1])) !== null) {
    const text = htmlToText(p[1]).trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

function extractCreator(html: string): string | undefined {
  // The creator's name appears in the `<table class="creator-info">` block,
  // in the <td> immediately after the profile-pic cell.
  const block = html.match(/<table class="creator-info">[\s\S]*?<\/table>/);
  if (!block) return undefined;
  // Last <td> in the row that contains text other than the "Created by:" label.
  const tds = [...block[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
    htmlToText(m[1]).trim(),
  );
  for (const td of tds) {
    if (!td) continue;
    if (/^created by:?$/i.test(td)) continue;
    return td;
  }
  return undefined;
}

function extractResponses(html: string): SignUpDetails['responses'] {
  const yesNoMaybe = html.match(/Yes:\s*(\d+)[\s\S]{0,80}?No:\s*(\d+)[\s\S]{0,80}?Maybe:\s*(\d+)/);
  if (!yesNoMaybe) return undefined;
  const responses: NonNullable<SignUpDetails['responses']> = {
    yes: Number(yesNoMaybe[1]),
    no: Number(yesNoMaybe[2]),
    maybe: Number(yesNoMaybe[3]),
  };
  const guests = html.match(/Confirmed:\s*(\d+)[\s\S]{0,80}?Maybe:\s*(\d+)/);
  if (guests) {
    responses.confirmedGuests = Number(guests[1]);
    responses.maybeGuests = Number(guests[2]);
  }
  return responses;
}

function textAfterStrong(html: string, label: string): string | undefined {
  // Matches `<strong>Date: </strong>05/21/2026 (Thu.)` and similar — captures
  // until the next tag or stretch of whitespace+newline+tag.
  const re = new RegExp(`<strong>\\s*${label}\\s*:?\\s*</strong>([\\s\\S]*?)(?=<(?!br)|$)`, 'i');
  const m = html.match(re);
  if (!m) return undefined;
  const value = htmlToText(m[1]).trim();
  return value || undefined;
}

function textOf(html: string, re: RegExp): string | undefined {
  const m = html.match(re);
  if (!m) return undefined;
  const value = htmlToText(m[1]).trim();
  return value || undefined;
}

function htmlToText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ');
}

export function registerPublicSignUpTools(
  server: McpServer,
  fetcher: Fetcher = (url) => globalThis.fetch(url),
): void {
  server.registerTool(
    'signupgenius_get_public_signup',
    {
      description:
        'Look up a SignUpGenius sign-up by its public URL or slug ' +
        '(e.g. `https://www.signupgenius.com/go/<urlid>-<signupid>-<vanity>`). ' +
        'Fetches the rendered page and returns a structured envelope: ' +
        'title, organization, date, time, location, description, creator, and ' +
        'RSVP response counts (when present). Requires no SignUpGenius auth — ' +
        'works even when the server has no API credentials configured. Use this ' +
        'when the user pastes a sign-up link and asks what it is or when it is.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: inputSchema.shape,
    },
    async (raw) => {
      const args = inputSchema.parse(raw);
      const parts = parseSignUpUrl(args.url);
      const res = await fetcher(parts.href);
      if (!res.ok) {
        throw new Error(`SignUpGenius returned HTTP ${res.status} for ${parts.href}`);
      }
      const html = await res.text();
      return textContent(extractSignUpDetails(html, parts));
    },
  );
}
