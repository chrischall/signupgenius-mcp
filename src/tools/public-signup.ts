import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textContent } from './_shared.js';
import {
  legacyPost,
  htmlToParagraphs,
  htmlToText,
  type Fetcher,
  type FetchResponseLike,
  type FetchInitLike,
} from './sug-legacy.js';

export type { Fetcher, FetchResponseLike, FetchInitLike };

/**
 * Public sign-up metadata — `POST /SUGboxAPI.cfm?go=s.getSignupInfo`.
 *
 * This tool used to scrape the `/go/` page HTML. That stopped working: the
 * modern page is a pure Angular shell whose served markup contains no sheet
 * content at all — no `h1.SUGHeaderText`, no Date/Time/Location landmarks, and
 * a constant `<title>Sign Me Up</title>`. The scraper therefore returned a stub
 * ("Sign Me Up", empty description) for every current sheet.
 *
 * The replacement is the JSON call the SPA itself makes. Verified live on
 * 2026-08-10 against sign-up 62393618:
 *
 *   - It needs NO authentication. A cold `curl` with an empty cookie jar
 *     returns the identical 10 KB envelope that the signed-in browser gets
 *     (10048 vs 10075 bytes — the delta is theme/ad noise, not sheet data).
 *   - It needs NO `s.PreProcessSignup` priming and NO prior `/go/` GET. All
 *     three orderings (cold, after-GET, after-preprocess) return byte-identical
 *     DATA, so this is a single request, not the documented 3-step dance.
 *
 * What it does NOT carry is slots — the sheet's rows live on a different
 * endpoint entirely (see slots.ts). `getSignupInfo` is metadata only, in both
 * anonymous and authenticated modes.
 */

export interface SignUpUrlParts {
  /** The full slug, e.g. `10C0849AAAA2EA4FD0-62393618-20262027`. */
  urlid: string;
  /** The numeric sign-up ID from the middle segment. */
  signupid: number;
  /** The optional vanity suffix, lower-cased. `undefined` when absent. */
  vanity: string | undefined;
  /** Canonical https URL for the sign-up page. */
  href: string;
}

/** The subset of the `s.getSignupInfo` DATA payload this tool surfaces. */
export interface RawSignupInfo {
  id?: number;
  urlid?: string;
  title?: string;
  description?: string;
  fullurl?: string;
  community?: string;
  communityid?: number;
  listType?: string;
  listformat?: string;
  contactname?: string;
  ownerfirst?: string;
  ownerlast?: string;
  owneremail?: string;
  owner?: number;
  datecreated?: string;
  datemodified?: string;
  tzshort?: string;
  useRSVP?: number;
  showRSVP?: number;
  accountRequired?: number;
  emailrequired?: number;
  commentRequired?: number;
  hascustomfields?: boolean;
  customfields?: RawCustomField[];
  hideslotsbefore?: string;
  hideslotsafter?: string;
  shownames?: number;
  signupimage?: string;
}

interface RawCustomField {
  fieldtype?: string;
  fieldname?: string;
  required?: boolean;
  fieldorder?: number;
  /**
   * Option list for Select-style fields. SignUpGenius emits this array with
   * INCONSISTENT key casing — observed live, the placeholder row uses
   * lower-case (`optionname`/`optionval`) while every real choice after it
   * uses upper-case (`OPTIONNAME`/`OPTIONVAL`). Reading only one casing
   * silently drops the actual options, so both are accepted.
   */
  fieldvalues?: Array<Record<string, unknown>>;
}

export interface CustomFieldSummary {
  /** e.g. `PhoneType`, `Phone`, `Text` — the wire `fieldtype`. */
  type: string;
  /** Human label when the sheet supplies one. */
  name?: string;
  required: boolean;
  /** Select-style fields advertise their options; free-text fields do not. */
  options?: string[];
}

export interface SignUpDetails {
  urlid: string;
  signupid: number;
  vanity?: string;
  url: string;
  title: string;
  /** Plain-text paragraphs, converted from the stored rich-text HTML. */
  description: string[];
  organization?: string;
  organizationId?: number;
  category?: string;
  format?: string;
  creator?: string;
  creatorEmail?: string;
  creatorId?: number;
  timezone?: string;
  created?: string;
  modified?: string;
  /** True for Yes/No/Maybe sheets; false for slot-based ones. */
  isRsvp: boolean;
  /** True when SignUpGenius requires an account to sign up. */
  accountRequired: boolean;
  /** Fields a participant must supply when claiming a slot. */
  customFields?: CustomFieldSummary[];
  image?: string;
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

/** Fetch the raw `s.getSignupInfo` DATA payload. No auth required. */
export async function fetchSignupInfo(
  fetcher: Fetcher,
  urlid: string,
): Promise<RawSignupInfo> {
  return legacyPost<RawSignupInfo>(fetcher, 's.getSignupInfo', { urlid });
}

/** Map the raw envelope onto the tool's response shape. Pure / testable. */
export function toSignUpDetails(raw: RawSignupInfo, parts: SignUpUrlParts): SignUpDetails {
  const out: SignUpDetails = {
    urlid: parts.urlid,
    signupid: raw.id ?? parts.signupid,
    url: raw.fullurl || parts.href,
    title: htmlToText(raw.title ?? '') || 'Untitled sign-up',
    description: htmlToParagraphs(raw.description ?? ''),
    isRsvp: Number(raw.useRSVP) === 1,
    accountRequired: Number(raw.accountRequired) === 1,
  };
  if (parts.vanity !== undefined) out.vanity = parts.vanity;

  const creator = joinName(raw.ownerfirst, raw.ownerlast) || raw.contactname;
  if (creator) out.creator = creator;
  if (raw.owneremail) out.creatorEmail = raw.owneremail;
  if (raw.owner !== undefined) out.creatorId = raw.owner;

  if (raw.community) out.organization = raw.community;
  if (raw.communityid !== undefined) out.organizationId = raw.communityid;
  if (raw.listType) out.category = raw.listType;
  if (raw.listformat) out.format = raw.listformat;
  if (raw.tzshort) out.timezone = raw.tzshort;
  if (raw.datecreated) out.created = raw.datecreated;
  if (raw.datemodified) out.modified = raw.datemodified;
  // The theme block ships a bare directory when the sheet has no banner.
  if (raw.signupimage && !/\/$/.test(raw.signupimage)) out.image = raw.signupimage;

  const fields = toCustomFields(raw.customfields);
  if (fields.length > 0) out.customFields = fields;

  return out;
}

/**
 * Summarise the sheet's custom questions.
 *
 * These matter beyond display: a slot claim must echo every `required` field
 * back or the CFML validator rejects the submission. The test sheet mandates
 * `PhoneType` + `Phone`.
 */
export function toCustomFields(raw: RawCustomField[] | undefined): CustomFieldSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((f) => {
    const summary: CustomFieldSummary = {
      type: f.fieldtype ?? 'Text',
      required: f.required === true,
    };
    if (f.fieldname) summary.name = f.fieldname;
    // `fieldvalues` is an array for Select-style fields but an empty STRING
    // for free-text ones (observed live on the Phone field), so it cannot be
    // spread or filtered without this guard.
    const values = Array.isArray(f.fieldvalues) ? f.fieldvalues : [];
    const options = values
      // Keep only rows with a real submit value: the leading row is a
      // "Select Type" placeholder whose value is empty and which is not a
      // legal answer.
      .filter((v) => String(pick(v, 'optionval') ?? '').length > 0)
      .map((v) => pick(v, 'optionname'))
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (options.length > 0) summary.options = options;
    return summary;
  });
}

/** Read a key from a case-inconsistent wire object. */
function pick(obj: Record<string, unknown>, key: string): string | undefined {
  const hit = Object.entries(obj).find(([k]) => k.toLowerCase() === key);
  return hit && typeof hit[1] === 'string' ? hit[1] : undefined;
}

function joinName(first?: string, last?: string): string {
  return [first, last].filter((p) => typeof p === 'string' && p.trim().length > 0).join(' ').trim();
}

export function registerPublicSignUpTool(
  server: McpServer,
  fetcher: Fetcher = (url, init) => globalThis.fetch(url, init),
): void {
  server.registerTool(
    'signupgenius_get_public_signup',
    {
      description:
        'Look up a SignUpGenius sign-up by its public URL or slug ' +
        '(e.g. `https://www.signupgenius.com/go/<urlid>-<signupid>-<vanity>`). ' +
        'Returns the real sheet metadata: title, description, organization, ' +
        'category, creator + contact email, timezone, created/modified dates, ' +
        'whether it is an RSVP or slot-based sheet, and which custom fields a ' +
        'participant must supply to sign up. Requires NO SignUpGenius auth and ' +
        'works for sheets the user did not create. Use signupgenius_list_slots ' +
        'for the actual dates/times and availability — this tool returns ' +
        'metadata only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: inputSchema.shape,
    },
    async (raw) => {
      const args = inputSchema.parse(raw);
      const parts = parseSignUpUrl(args.url);
      const info = await fetchSignupInfo(fetcher, parts.urlid);
      return textContent(toSignUpDetails(info, parts));
    },
  );
}
