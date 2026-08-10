/**
 * Shared helpers for the unauthenticated legacy `/SUGboxAPI.cfm` dispatcher.
 *
 * Three of this server's read paths (`s.getSignupInfo`,
 * `s.getSignUpParticipantsBySlotItem`, `s.getSignUpFormItems`) are reachable
 * with NO cookies, NO JWT and NO ColdFusion session — verified live on
 * 2026-08-10 against sign-up 62393618 from a cold `curl` with an empty cookie
 * jar. They therefore bypass `SignUpGeniusClient` entirely, exactly like the
 * v3 slots endpoint, so that they keep working when `resolveAuth()` has
 * deferred a config error.
 *
 * The dispatcher answers in the upper-case `{MESSAGE, DATA, SUCCESS, CODE}`
 * envelope (the v2/v3 JSON API uses lower-case keys — see
 * `normalizeLegacyShape` in client.ts for the authenticated counterpart).
 */

/** Minimum surface of a fetch response these helpers use. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Injectable fetch. Defaults to `globalThis.fetch`; tests pass a stub.
 * `init` is optional so existing GET-only callers stay source-compatible.
 */
export type Fetcher = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export const LEGACY_BASE = 'https://www.signupgenius.com';

/** The upper-case envelope the legacy dispatcher returns. */
export interface LegacyEnvelope<T> {
  MESSAGE?: string[] | string;
  DATA?: T;
  SUCCESS?: boolean;
  CODE?: string;
}

/**
 * POST a JSON body to `/SUGboxAPI.cfm?go=<action>` and unwrap `DATA`.
 *
 * Deliberately sends no credentials: these actions are public, and attaching a
 * stale/bogus Authorization header is what makes sibling SignUpGenius
 * endpoints 500 (see the v3 slots note in slots.ts).
 */
export async function legacyPost<T>(
  fetcher: Fetcher,
  action: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = `${LEGACY_BASE}/SUGboxAPI.cfm?go=${action}`;
  const res = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`SignUpGenius returned HTTP ${res.status} for ${action}.`);
  }
  const text = await res.text();
  let parsed: LegacyEnvelope<T>;
  try {
    parsed = JSON.parse(text) as LegacyEnvelope<T>;
  } catch {
    throw new Error(
      `SignUpGenius returned a non-JSON body for ${action}. ` +
        'The sign-up may not exist, or the dispatcher served an HTML error page.',
    );
  }
  if (parsed.SUCCESS !== true) {
    throw new Error(`SignUpGenius error from ${action}: ${legacyMessage(parsed) || 'unknown'}`);
  }
  // `DATA` is optional on the wire. Casting it away turned a `SUCCESS:true`
  // envelope with a null/missing DATA into `undefined`, which callers then
  // dereferenced — a TypeError stack trace where an actionable message belongs.
  if (parsed.DATA === undefined || parsed.DATA === null) {
    throw new Error(
      `SignUpGenius returned an empty payload from ${action}. ` +
        'The sign-up or slot may not exist, or may no longer be public.',
    );
  }
  return parsed.DATA;
}

/** Flatten `MESSAGE` (string or array) into one plain-text line. */
export function legacyMessage<T>(env: LegacyEnvelope<T>): string {
  const raw = env.MESSAGE;
  const joined = Array.isArray(raw) ? raw.join('; ') : raw ?? '';
  return htmlToText(joined).trim();
}

/**
 * Collapse a SignUpGenius rich-text field into plain-text paragraphs.
 *
 * `description` arrives as stored HTML (`<p>` blocks, `&nbsp;`, `<br>`), which
 * is unreadable when handed to a model verbatim.
 */
export function htmlToParagraphs(html: string): string[] {
  if (!html) return [];
  const blocks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/<\/p>|<\/div>|<\/li>/i)
    .map((chunk) => htmlToText(chunk).trim())
    .filter((chunk) => chunk.length > 0);
  return blocks;
}

/** Strip tags and decode the entity set SignUpGenius actually emits. */
export function htmlToText(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}
