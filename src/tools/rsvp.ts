import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SignUpGeniusClient } from '../client.js';
import { textContent } from './_shared.js';
import { parseSignUpUrl, type SignUpUrlParts } from './public-signup.js';

/**
 * Authenticated RSVP write tool — session/fetchproxy mode only.
 *
 * The user-facing API is small (URL + yes/no/maybe + optional guest counts
 * and comment), but the wire-side flow has three steps, mirroring the
 * Angular wizard in `/dist/js/main/signupform.min.js`:
 *
 *   1. POST `/index.cfm?go=s.PreProcessSignup&URLID=<urlid>` (form-encoded).
 *      Server sets a ColdFusion-session pointer to "this sign-up is being
 *      processed by member X" — without it every follow-up SUGboxAPI call
 *      returns `"Oops! Looks like there's none to be processed"`.
 *   2. POST `/SUGboxAPI.cfm?go=s.getSignupInfo` with `{ urlid }`. Returns the
 *      full sign-up object — we use `useRSVP` to gate the flow (slot-based
 *      sign-ups need a different submission path that this tool does NOT
 *      implement yet) and `rsvpdetails.slotid` to populate the payload.
 *   3. POST `/SUGboxAPI.cfm?go=s.processSignUpFormHandler` with the payload
 *      built by `buildRsvpPayload`. Server returns `{ success, message,
 *      data }`; we surface failures as thrown errors.
 *
 * Slot-style sign-ups are explicitly rejected here. The wizard's submission
 * path for those is `type:"standard"` with an `items: [...]` list and a
 * separate `s.getSignUpFormItems` call — different enough that it deserves
 * its own tool.
 */

/** Subset of the `s.getSignupInfo` envelope this tool relies on. */
export interface SignupInfo {
  id: number;
  /** Creator's member id — the wizard sends this as `owner` in the payload. */
  owner: number;
  urlid: string;
  title: string;
  /** `1` for RSVP-style sign-ups, `0` for slot-style. */
  useRSVP: number;
  emailrequired?: number;
  rsvpdetails: {
    slotid: number;
    starttime?: string;
    endtime?: string;
    location?: string;
    usetime?: number;
    /**
     * Per-line-item slots (e.g. "lasagna", "salad"). Empty/absent on the
     * headcount-only RSVP variant; populated when the sign-up owner has
     * configured "guests must pick an item to bring". This tool only handles
     * the headcount variant — see the item-based branch in `buildRsvpPayload`.
     */
    rsvpitems?: unknown[];
  };
}

export interface RsvpInput {
  url: string;
  response: 'yes' | 'no' | 'maybe';
  adults?: number;
  children?: number;
  comment?: string;
  firstname: string;
  lastname: string;
  email: string;
}

/**
 * Wire-format payload sent to `s.processSignUpFormHandler`. Mirrors
 * `d.ProcessSignUp` in `/dist/js/signups/signup.min.js` — every field the
 * wizard's `d.objForm` carries is present, plus the handful added at
 * submit-time (`type`, `source`, `slotid`, `isLoggedin`, `payLater`,
 * `customFields`).
 *
 * The CFML validator on the receiving end reads `RSVPITEMS` unconditionally;
 * omitting it triggers `key [RSVPITEMS] doesn't exist` from
 * `structKeyExists`. Always emit it as `[]` on the headcount-only variant.
 */
export interface RsvpPayload {
  // objForm fields
  listid: number;
  owner: number;
  urlid: string;
  title: string;
  siid: string;
  rsvpid: number;
  imid: number;
  usealternatename: boolean;
  /** `changemembermame` is misspelled in the wizard JS — preserve the typo. */
  changemembermame: boolean;
  displayfirstname: string;
  displaylastname: string;
  firstname: string;
  lastname: string;
  email: string;
  optInStatus: boolean;
  savecontactinfo: boolean;
  rsvpresponse: 'y' | 'n' | 'm';
  rsvpadult: number;
  rsvpchildren: number;
  rsvpitems: never[];
  rsvpcomments: string;
  // Fields added by d.ProcessSignUp on top of objForm
  type: 'rsvp';
  source: 'main';
  slotid: number;
  isLoggedin: true;
  payLater: false;
  customFields: never[];
}

const RESPONSE_LETTER: Record<RsvpInput['response'], RsvpPayload['rsvpresponse']> = {
  yes: 'y',
  no: 'n',
  maybe: 'm',
};

const inputSchema = z.object({
  url: z
    .string()
    .min(1)
    .describe(
      'SignUpGenius sign-up URL (https://www.signupgenius.com/go/<slug>) or just the slug.',
    ),
  response: z
    .enum(['yes', 'no', 'maybe'])
    .describe('RSVP response. Maps to the wizard\'s Yes / No / Maybe buttons.'),
  adults: z
    .number()
    .int()
    .min(0)
    .max(99)
    .optional()
    .describe('Adult guest count. Defaults to 1 for yes/maybe, 0 for no.'),
  children: z
    .number()
    .int()
    .min(0)
    .max(99)
    .optional()
    .describe('Child guest count. Defaults to 0.'),
  comment: z.string().max(500).optional().describe('Optional comment shown to the sign-up owner.'),
  firstname: z.string().min(1),
  lastname: z.string().min(1),
  email: z.string().email(),
});

/** Translate input + sign-up metadata into the wire payload. Pure / testable. */
export function buildRsvpPayload(
  parts: SignUpUrlParts,
  info: SignupInfo,
  input: RsvpInput,
): RsvpPayload {
  const letter = RESPONSE_LETTER[input.response];
  // Mirror the wizard JS: "n" forces both guest counts to zero, regardless of
  // what the user typed. "y" and "m" default to a head count of 1 (the user
  // themselves) plus zero children.
  const isNo = letter === 'n';
  const adults = isNo ? 0 : input.adults ?? 1;
  const children = isNo ? 0 : input.children ?? 0;
  return {
    listid: info.id,
    owner: info.owner,
    urlid: parts.urlid,
    title: info.title,
    siid: '',
    rsvpid: 0,
    imid: 0,
    usealternatename: false,
    changemembermame: false,
    displayfirstname: input.firstname,
    displaylastname: input.lastname,
    firstname: input.firstname,
    lastname: input.lastname,
    email: input.email,
    optInStatus: false,
    savecontactinfo: false,
    rsvpresponse: letter,
    rsvpadult: adults,
    rsvpchildren: children,
    rsvpitems: [],
    rsvpcomments: input.comment ?? '',
    type: 'rsvp',
    source: 'main',
    slotid: info.rsvpdetails.slotid,
    isLoggedin: true,
    payLater: false,
    customFields: [],
  };
}

/**
 * True when `getSignupInfo` reports per-item slots on an RSVP-style sheet
 * (e.g. "Yes, I'll bring lasagna"). Headcount-only RSVPs leave `rsvpitems`
 * empty or unset. We only handle the headcount variant — the item variant
 * needs a separate input surface (per-slot quantities + comments) that this
 * tool doesn't expose.
 */
export function isItemBasedRsvp(info: SignupInfo): boolean {
  const items = info.rsvpdetails.rsvpitems;
  return Array.isArray(items) && items.length > 0;
}

export function registerRsvpTool(server: McpServer, client: SignUpGeniusClient): void {
  // Key mode doesn't have the cookie/JWT surface this flow needs, and the
  // documented Pro API has no equivalent. Skip registration entirely so the
  // tool listing is honest about what's reachable.
  if (client.mode !== 'session') return;

  server.registerTool(
    'signupgenius_rsvp',
    {
      description:
        'RSVP to a SignUpGenius sign-up (the Yes/No/Maybe-style sheets, ' +
        'including invitations from family/friends). Walks the PreProcessSignup ' +
        '→ getSignupInfo → processSignUpFormHandler flow under the hood. ' +
        'Writes data — confirm with the user before invoking. Slot-based ' +
        'sign-ups (e.g. "claim the 3pm slot") are NOT supported by this tool; ' +
        'a slot signup tool is a separate concern.',
      annotations: { readOnlyHint: false },
      inputSchema: inputSchema.shape,
    },
    async (raw) => {
      const args = inputSchema.parse(raw);
      const parts = parseSignUpUrl(args.url);

      await client.preProcessSignUp(parts.urlid);

      const infoRes = await client.request<SignupInfo>('', {
        legacyAction: 's.getSignupInfo',
        body: { urlid: parts.urlid },
      });
      const info = infoRes.data;
      if (Number(info.useRSVP) !== 1) {
        throw new Error(
          `Sign-up ${parts.urlid} is not an RSVP-style sheet (useRSVP=${info.useRSVP}). ` +
            'This tool only handles Yes/No/Maybe responses. Slot-based sign-ups need a separate tool.',
        );
      }
      if (isItemBasedRsvp(info)) {
        // Length is safe to read because isItemBasedRsvp confirmed the array.
        const itemCount = info.rsvpdetails.rsvpitems!.length;
        throw new Error(
          `Sign-up ${parts.urlid} is an item-based RSVP — guests must pick from ` +
            `${itemCount} item slot(s) ` +
            "(e.g. \"Yes, I'll bring lasagna\"). This tool only handles the " +
            'headcount-only RSVP variant. Use the SignUpGenius web UI for ' +
            'item-based responses until a dedicated tool ships.',
        );
      }

      const payload = buildRsvpPayload(parts, info, args);
      const result = await client.request('', {
        legacyAction: 's.processSignUpFormHandler',
        body: payload,
      });
      if (!result.success) {
        const detail = result.message.length > 0 ? result.message.join('; ') : 'unknown';
        throw new Error(`RSVP submit failed: ${detail}`);
      }
      return textContent({
        success: true,
        signupid: parts.signupid,
        urlid: parts.urlid,
        title: info.title,
        response: args.response,
        adults: payload.rsvpadult,
        children: payload.rsvpchildren,
        comment: payload.rsvpcomments,
        server: result.data,
      });
    },
  );
}
