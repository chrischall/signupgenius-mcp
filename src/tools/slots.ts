import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textContent } from './_shared.js';
import { parseSignUpUrl } from './public-signup.js';
import { legacyPost, type Fetcher } from './sug-legacy.js';

/**
 * Slot listing — the primary participant question ("what's still open?").
 *
 * Two endpoints, BOTH fully unauthenticated (verified live 2026-08-10 against
 * sign-up 62393618 from a cold `curl`, empty cookie jar):
 *
 *   1. `GET https://api.signupgenius.com/v3/signups/{id}/slots`
 *      Structure + availability. Must be called with NO headers: a bogus
 *      `Authorization` makes it 500, and a valid session returns a
 *      byte-identical body.
 *
 *   2. `POST /SUGboxAPI.cfm?go=s.getSignUpParticipantsBySlotItem`
 *      `{listid, slotitemid, offset, limitTo, search, orderBy, orderDesc,
 *        memberidViewing}` — who is in a given slot, with per-entry `myqty`.
 *
 * Why both: (1) reports `taken` (quantity-weighted) and `participantcount`
 * (distinct people) but returns an EMPTY `itemmembers` list on this sheet,
 * because the slot carries `hidenames: true`. (2) returns the names anyway,
 * unauthenticated, along with the `myqty` that reconciles the two counts.
 *
 * That reconciliation is the subtle part and the reason a naive name-count is
 * wrong. On 10/24/2026 the sheet reads "4 of 6 filled" across only THREE name
 * entries, because one of them carries `myqty: 2` (a couple signing up
 * together renders as a single name).
 * `filled_count` therefore comes from `taken`, never from `participants.length`.
 *
 * Neither endpoint is a substitute for the Pro `report_*` tools: those are
 * key-only AND owner-scoped, so they cannot answer this question for a sheet
 * the user merely participates in. These two can.
 */

const SLOTS_BASE = 'https://api.signupgenius.com/v3/signups';

/** Parallel participant lookups. Small on purpose — legacy CFML dispatcher. */
const PARTICIPANT_CONCURRENCY = 4;
/** Hard ceiling on participant lookups per call, so a huge sheet still returns. */
const MAX_PARTICIPANT_LOOKUPS = 60;

const inputSchema = z.object({
  url: z
    .string()
    .min(1)
    .describe(
      'A SignUpGenius sign-up URL, its slug (`<urlid>-<signupid>[-<vanity>]`), ' +
        'or just the numeric sign-up id.',
    ),
  includeParticipants: z
    .boolean()
    .optional()
    .describe(
      'Fetch the name + quantity of everyone already signed up (default true). ' +
        'Costs one extra request per slot row; set false for a fast availability-only view.',
    ),
  onlyAvailable: z
    .boolean()
    .optional()
    .describe('Return only slots that still have room. Default false (return all).'),
});

export interface Participant {
  display_name: string;
  /** Spots this entry consumes. A couple signing up together counts as 2. */
  quantity: number;
  comment?: string;
  /**
   * The entry's `itemmemberid`. This is the `imid` that
   * `signupgenius_release_slot` needs to withdraw a sign-up.
   */
  item_member_id?: number;
  member_id?: number;
}

export interface SlotSummary {
  slot_label: string;
  slotid: number;
  slotitemid: number;
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  day_of_week: string;
  /** `HH:MM` local, or null on date-only rows (e.g. "time TBD" competitions). */
  start_time: string | null;
  end_time: string | null;
  title?: string;
  location?: string;
  capacity: number | null;
  filled_count: number;
  available_count: number | null;
  is_full: boolean;
  /**
   * The organizer has locked the sheet (or this row) against new sign-ups.
   * A locked row still reports `state: 'available'`, so without this a caller
   * would offer a slot that the server then refuses.
   */
  locked: boolean;
  unlimited: boolean;
  /** Distinct people, which can be LOWER than filled_count (see module docs). */
  participant_count: number;
  /** Owner's display preference. Names may still be readable via endpoint (2). */
  names_hidden: boolean;
  participants?: Participant[];
}

interface RawSlotsEnvelope {
  success?: boolean;
  message?: string[];
  data?: { slots?: RawSlot[] };
}
interface RawSlot {
  slotid?: number;
  title?: string;
  hidenames?: boolean;
  slotitems?: RawSlotItem[];
}
interface RawSlotItem {
  slotitemid?: number;
  quantity?: {
    limit?: number | null;
    taken?: number;
    remaining?: number | null;
    unlimited?: boolean;
    participantcount?: number;
  };
  availability?: { state?: string; signuplocked?: boolean; addlocked?: boolean };
  date?: {
    starttime?: string | null;
    endtime?: string | null;
    hastime?: boolean;
    location?: { name?: string | null; displaytext?: string | null } | null;
  } | null;
}

interface RawParticipant {
  firstname?: string;
  lastname?: string;
  nonmembername?: string;
  myqty?: number;
  mycomment?: string;
  itemmemberid?: number;
  memberid?: number;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Resolve the numeric sign-up id from a URL, a slug, or a bare id. */
export function resolveSignUpId(input: string): number {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return parseSignUpUrl(trimmed).signupid;
}

/**
 * Split a SignUpGenius local timestamp into date / weekday / clock time.
 *
 * The API sends naive local strings (`2026-10-24T00:00:00`) with the sheet's
 * timezone reported separately, so these are parsed as literal fields. Using
 * `new Date(...)` would re-interpret them in the host's zone and shift dates
 * across midnight — the "time TBD" rows sit exactly at 00:00 and would move.
 *
 * This returns the clock time verbatim; deciding that a row is date-only is
 * `isDateOnly`'s job, because 00:00 by itself is ambiguous (a genuine midnight
 * start looks identical to an unset time, and `hastime` is `true` on both).
 */
export function splitTimestamp(ts: string | null | undefined): {
  date: string;
  day_of_week: string;
  time: string | null;
} {
  const m = String(ts ?? '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return { date: '', day_of_week: '', time: null };
  const [, y, mo, d, hh, mm] = m;
  const date = `${y}-${mo}-${d}`;
  // Date.UTC avoids any local-timezone shift in the weekday lookup.
  const day = DAYS[new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).getUTCDay()];
  const time = hh === undefined ? null : `${hh}:${mm}`;
  return { date, day_of_week: day, time };
}

/**
 * True when a row carries a date but no meaningful time.
 *
 * The "time TBD" competition rows arrive as `starttime: T00:00:00` with a null
 * `endtime`. A genuine midnight start is indistinguishable from that on
 * `starttime` alone — and `hastime` is `true` for both, so it is not a usable
 * discriminator — but a real timed row on these sheets always carries an
 * `endtime`. Requiring BOTH midnight AND a missing endtime keeps a real
 * 12:00 AM slot (which has an end) from being mislabelled "TBD".
 */
export function isDateOnly(start: string | null | undefined, end: string | null | undefined): boolean {
  return /T00:00(:00)?$/.test(String(start ?? '')) && !end;
}

/** Flatten the v3 slots envelope into one row per slot item. */
export function extractSlots(raw: RawSlotsEnvelope): SlotSummary[] {
  const out: SlotSummary[] = [];
  for (const slot of raw.data?.slots ?? []) {
    for (const item of slot.slotitems ?? []) {
      const q = item.quantity ?? {};
      const start = splitTimestamp(item.date?.starttime);
      const end = splitTimestamp(item.date?.endtime);
      const dateOnly = isDateOnly(item.date?.starttime, item.date?.endtime);
      const limit = q.limit ?? null;
      const taken = q.taken ?? 0;
      const unlimited = q.unlimited === true;
      const summary: SlotSummary = {
        slot_label: slot.title ?? '(untitled slot)',
        slotid: slot.slotid ?? 0,
        slotitemid: item.slotitemid ?? 0,
        date: start.date,
        day_of_week: start.day_of_week,
        start_time: dateOnly ? null : start.time,
        end_time: end.time,
        capacity: unlimited ? null : limit,
        filled_count: taken,
        available_count: unlimited ? null : q.remaining ?? null,
        // `state` alone is not enough: a finite row can report `remaining: 0`
        // without the exact token 'full'.
        is_full:
          item.availability?.state === 'full' ||
          (!unlimited && (q.remaining ?? null) === 0),
        locked:
          item.availability?.signuplocked === true || item.availability?.addlocked === true,
        unlimited,
        participant_count: q.participantcount ?? 0,
        names_hidden: slot.hidenames === true,
      };
      const loc = item.date?.location;
      // `displaytext` is the row's headline ("Football Away @ Providence Day");
      // `name` is the venue. Both are useful, so keep them distinct.
      if (loc?.displaytext) summary.title = loc.displaytext;
      if (loc?.name) summary.location = loc.name;
      out.push(summary);
    }
  }
  return out;
}

/** Map one `s.getSignUpParticipantsBySlotItem` row to our shape. */
export function toParticipant(raw: RawParticipant): Participant {
  const name =
    [raw.firstname, raw.lastname]
      .filter((p) => typeof p === 'string' && p.trim().length > 0)
      .join(' ')
      .trim() ||
    raw.nonmembername ||
    '(name withheld)';
  const p: Participant = { display_name: name, quantity: Number(raw.myqty) || 1 };
  if (raw.mycomment) p.comment = raw.mycomment;
  if (raw.itemmemberid !== undefined) p.item_member_id = raw.itemmemberid;
  if (raw.memberid) p.member_id = raw.memberid;
  return p;
}

/** Fetch the participant list for a single slot item. Unauthenticated. */
export async function fetchParticipants(
  fetcher: Fetcher,
  listid: number,
  slotitemid: number,
  expected: number,
): Promise<Participant[]> {
  const data = await legacyPost<{ participants?: RawParticipant[] }>(
    fetcher,
    's.getSignUpParticipantsBySlotItem',
    {
      listid,
      slotitemid,
      offset: 1,
      // Ask for comfortably more than the reported count so a row that grew
      // between the two calls is not silently truncated.
      limitTo: Math.max(expected, 0) + 50,
      search: '',
      orderBy: '',
      orderDesc: false,
      memberidViewing: 0,
    },
  );
  return (data?.participants ?? []).map(toParticipant);
}

export function registerSlotTools(
  server: McpServer,
  fetcher: Fetcher = (url, init) => globalThis.fetch(url, init),
): void {
  server.registerTool(
    'signupgenius_list_slots',
    {
      description:
        'List every SLOT on a SignUpGenius sign-up — date, day of week, start/end ' +
        'time, title, location, capacity, how many spots are filled vs still ' +
        'available, and who has already signed up (with the quantity each entry ' +
        'consumes). Accepts a sign-up URL, slug, or numeric id. Requires NO auth ' +
        'and works for sheets the user did NOT create, which is exactly the case ' +
        'the Pro signupgenius_report_* tools cannot serve (they are key-only AND ' +
        'owner-scoped). This is the right tool for "what is still open?".',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: inputSchema.shape,
    },
    async (rawArgs) => {
      const args = inputSchema.parse(rawArgs);
      const signupid = resolveSignUpId(args.url);
      const url = `${SLOTS_BASE}/${signupid}/slots`;
      // Called with NO headers on purpose: a bogus Authorization makes this
      // endpoint 500, and a valid one changes nothing.
      const res = await fetcher(url);
      if (res.status === 404) {
        throw new Error(
          `SignUpGenius has no sign-up with id ${signupid} (404). ` +
            'Check the slug — the id is the middle segment of a /go/ link.',
        );
      }
      if (!res.ok) {
        throw new Error(`SignUpGenius returned HTTP ${res.status} for ${url}`);
      }
      const body = await res.text();
      let parsed: RawSlotsEnvelope;
      try {
        parsed = JSON.parse(body) as RawSlotsEnvelope;
      } catch {
        throw new Error(`SignUpGenius returned a non-JSON body for ${url}`);
      }
      if (parsed.success !== true) {
        const msg = (parsed.message ?? []).join('; ');
        throw new Error(`SignUpGenius error listing slots: ${msg || 'unknown'}`);
      }

      let slots = extractSlots(parsed);
      if (args.onlyAvailable) slots = slots.filter((s) => !s.is_full && !s.locked);

      // Participant names cost one legacy POST per row. Bound both the
      // concurrency (this is a legacy ColdFusion dispatcher, not an API
      // designed for fan-out) and the total, so a 200-row sheet cannot turn
      // one tool call into 200 sequential requests and blow the client's
      // timeout.
      let participantsSkipped = 0;
      const participantsFailed: number[] = [];
      if (args.includeParticipants !== false) {
        const targets = slots.slice(0, MAX_PARTICIPANT_LOOKUPS);
        participantsSkipped = slots.length - targets.length;
        let next = 0;
        const worker = async (): Promise<void> => {
          for (let i = next++; i < targets.length; i = next++) {
            const slot = targets[i];
            try {
              slot.participants = await fetchParticipants(
                fetcher,
                signupid,
                slot.slotitemid,
                slot.participant_count,
              );
            } catch {
              // One bad row degrades rather than failing the whole listing —
              // but record it, because `participants: undefined` otherwise
              // reads identically to "nobody signed up".
              slot.participants = undefined;
              participantsFailed.push(slot.slotitemid);
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(PARTICIPANT_CONCURRENCY, targets.length) }, worker),
        );
      }

      return textContent({
        signupid,
        source: url,
        slotCount: slots.length,
        // Unlimited rows have no finite remainder; folding them in as 0 made an
        // all-unlimited sheet report "0 remaining", which reads as full when it
        // is the opposite. `unlimitedSlots` carries what the sum cannot.
        totalAvailable: slots
          .filter((s) => !s.unlimited)
          .reduce((n, s) => n + (s.available_count ?? 0), 0),
        unlimitedSlots: slots.filter((s) => s.unlimited).length,
        // Never let a cap look like "nobody signed up" — say so explicitly.
        ...(participantsFailed.length > 0
          ? {
              participantsUnavailable: {
                slotitemids: participantsFailed,
                reason:
                  'The participant lookup failed for these rows, so their names are missing. ' +
                  'The counts are still accurate — this is NOT "nobody signed up".',
              },
            }
          : {}),
        ...(participantsSkipped > 0
          ? {
              participantsOmitted: {
                rows: participantsSkipped,
                reason:
                  `Participant lookup is capped at ${MAX_PARTICIPANT_LOOKUPS} rows per call. ` +
                  'The counts on those rows are still accurate; only the names are missing.',
              },
            }
          : {}),
        slots,
      });
    },
  );
}
