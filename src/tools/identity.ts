import type { SignUpGeniusClient } from '../client.js';

/**
 * Who a claim or RSVP is submitted as (fleet-audit#706).
 *
 * Both writes send `firstname`/`lastname`/`email` under the signed-in session
 * (`isLoggedin: true`), so the entry is tied to the ACCOUNT whatever name it
 * displays. Taking that identity free-form meant a model could sign the user
 * up under somebody else's name — legitimate for a family member, but easy to
 * do by accident, and the entry then shows a name that does not match the
 * account `signupgenius_release_slot` checks ownership against.
 *
 * So: omitted fields default from the account profile, and a supplied
 * identity that differs from it is flagged in the preview — never blocked.
 */

export interface Identity {
  firstname: string;
  lastname: string;
  email: string;
}

const FIELDS = ['firstname', 'lastname', 'email'] as const;
type Field = (typeof FIELDS)[number];

export type ProfileLookup =
  | { status: 'ok'; memberId?: number; identity: Partial<Identity> }
  | { status: 'unknown'; reason: string };

/**
 * The profile endpoint `signupgenius_get_profile` reads: v3 `/member/profile`
 * in session mode, v2/k `/user/profile` in key mode.
 */
export function profilePath(mode: SignUpGeniusClient['mode']): string {
  return mode === 'session' ? '/member/profile' : '/user/profile';
}

/**
 * Read the signed-in member's id, name and email. Never throws — a failed
 * lookup comes back as `unknown` so each caller decides what it can do
 * without it. Keys are matched case-insensitively because the two API
 * generations do not agree on casing.
 */
export async function readProfile(client: SignUpGeniusClient): Promise<ProfileLookup> {
  let data: unknown;
  try {
    data = (await client.request<unknown>(profilePath(client.mode))).data;
  } catch (err) {
    return {
      status: 'unknown',
      reason: `profile lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const row = Array.isArray(data) ? data[0] : data;
  const lower: Record<string, unknown> = {};
  if (row && typeof row === 'object') {
    for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
  }
  const identity: Partial<Identity> = {};
  for (const f of FIELDS) {
    const v = lower[f];
    if (typeof v === 'string' && v.trim()) identity[f] = v.trim();
  }
  const id = lower.id ?? lower.memberid;
  return { status: 'ok', memberId: typeof id === 'number' ? id : undefined, identity };
}

export function formatIdentity(i: Identity): string {
  return `${i.firstname} ${i.lastname} <${i.email}>`;
}

/** What the preview shows about the identity a write will use. */
export interface IdentityPreview {
  name: string;
  email: string;
  /** `account` = all defaulted, `supplied` = all from the caller, else `mixed`. */
  source: 'account' | 'supplied' | 'mixed';
  fromAccount: Field[];
  supplied: Field[];
  /** The signed-in account's identity, or why it is not known. */
  account: string;
  /** Present only when the supplied identity could not be compared. */
  accountCheck?: string;
}

export interface ResolvedIdentity {
  identity: Identity;
  preview: IdentityPreview;
  /** True when a supplied field differs from the account's value. */
  differs: boolean;
  /** Human-readable warning naming both identities, when `differs`. */
  note?: string;
}

function same(field: Field, a: string, b: string): boolean {
  return field === 'email' ? a.trim().toLowerCase() === b.trim().toLowerCase() : a.trim() === b.trim();
}

/**
 * Merge a caller-supplied (possibly partial) identity with the account.
 * Throws only when an omitted field cannot be read from the account — the
 * tool must not invent who is signing up.
 */
export function resolveIdentity(
  supplied: Partial<Identity>,
  lookup: ProfileLookup,
): ResolvedIdentity {
  const account = lookup.status === 'ok' ? lookup.identity : {};
  const fromAccount: Field[] = [];
  const given: Field[] = [];
  const missing: Field[] = [];
  const out: Partial<Identity> = {};
  for (const f of FIELDS) {
    const v = supplied[f]?.trim();
    if (v) {
      out[f] = v;
      given.push(f);
    } else if (account[f]) {
      out[f] = account[f];
      fromAccount.push(f);
    } else {
      missing.push(f);
    }
  }
  if (missing.length > 0) {
    const why = lookup.status === 'ok' ? 'field missing' : lookup.reason;
    throw new Error(
      `Could not read ${missing.join(', ')} from your SignUpGenius profile (${why}), so the ` +
        'sign-up identity cannot be defaulted. Check signupgenius_get_profile, or pass ' +
        'firstname, lastname and email explicitly.',
    );
  }
  const identity = out as Identity;

  const unknownFields = given.filter((f) => !account[f]);
  const differs = given.some((f) => account[f] !== undefined && !same(f, identity[f], account[f]!));
  const accountComplete = FIELDS.every((f) => account[f]);
  const accountText =
    lookup.status === 'unknown'
      ? `unavailable (${lookup.reason})`
      : accountComplete
        ? formatIdentity(account as Identity)
        : `incomplete (${FIELDS.filter((f) => !account[f]).join(', ')} missing)`;

  const preview: IdentityPreview = {
    name: `${identity.firstname} ${identity.lastname}`,
    email: identity.email,
    source: given.length === 0 ? 'account' : fromAccount.length === 0 ? 'supplied' : 'mixed',
    fromAccount,
    supplied: given,
    account: accountText,
  };
  if (unknownFields.length > 0) {
    preview.accountCheck =
      lookup.status === 'unknown'
        ? `could not compare the supplied identity with the signed-in account (${lookup.reason})`
        : `could not compare ${unknownFields.join(', ')} with the signed-in account (not in its profile)`;
  }

  const result: ResolvedIdentity = { identity, preview, differs };
  if (differs) {
    result.note =
      `This will be submitted as ${formatIdentity(identity)}, which is NOT the signed-in ` +
      `account (${accountText}). The entry is still tied to that account. Fine for signing ` +
      'up a family member — confirm with the user that it is intended.';
  }
  return result;
}
