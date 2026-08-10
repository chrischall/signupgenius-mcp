import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SignUpGeniusClient } from '../client.js';
import { textContent } from './_shared.js';
import { parseSignUpUrl, type SignUpUrlParts } from './public-signup.js';

/**
 * Slot claim + release — the two core participant WRITES.
 *
 * ── Provenance ────────────────────────────────────────────────────────────
 * The payload shapes below were reverse-engineered on 2026-08-10 from two
 * sources, NOT guessed:
 *
 *   a) The live Angular `objForm` object, read out of the signed-in sign-up
 *      wizard's scope while a real slot was selected. That gave the exact base
 *      key set — including the misspelled `changemembermame` — and confirmed
 *      `siid` is an ARRAY of slot-item ids.
 *   b) `d.ProcessSignUp` in `/dist/js/signups/signup.min.js`, which is what
 *      turns `objForm` into the submitted body:
 *
 *        i = d.objForm;
 *        i.type   = d.isrsvp ? "rsvp" : "standard";
 *        i.source = "main";
 *        if (!d.isrsvp) i.items = d.items;      // slot claims carry `items`
 *        i.member = d.user;
 *        i.isLoggedin = true (when logged in), i.firstname/lastname from user
 *        i.customFields = [...custom, ...cq_address, ...cq_phone]
 *        i.payLater = false;
 *
 * `items` comes from `s.getSignUpFormItems({listid, siid, hasProductImages})`,
 * which — contrary to earlier recon — works fine UNAUTHENTICATED. The previous
 * "Invalid Request" results were a parameter problem, not an auth problem:
 * `siid: 0`, `""` and `[]` all describe an EMPTY selection. Passing a real
 * slot-item id returns the row immediately.
 *
 * ── Verification status ───────────────────────────────────────────────────
 * The READ half of every step above is verified live. The final
 * `s.processSignUpFormHandler` POST and the `s.DeletePerson` GET have
 * deliberately NOT been exercised against the server: doing so would claim and
 * then withdraw a real slot on someone else's live sheet. Both tools therefore
 * ship behind a mandatory `confirm: true` gate, and default to returning a
 * preview instead of writing.
 */

/** Sign-up metadata needed to build a claim. From `s.getSignupInfo`. */
export interface ClaimSignupInfo {
  id: number;
  owner: number;
  title: string;
  useRSVP?: number;
  hascustomfields?: boolean;
}

/** One row of `s.getSignUpFormItems` DATA (upper-case on the wire). */
export interface FormItem {
  SLOTITEMID?: number;
  SLOTID?: number;
  ITEM?: string;
  LOCATION?: string;
  STARTTIME?: string;
  ENDTIME?: string;
  AVAILABLEQTY?: number;
  QTY?: number;
  PAYMENTREQUIRED?: number;
}

export interface CustomFieldInput {
  /** Wire `fieldtype`, e.g. `Phone`, `PhoneType`. */
  fieldtype: string;
  fieldname?: string;
  myvalue: string;
}

export interface ClaimInput {
  slotitemid: number;
  quantity: number;
  comment?: string;
  firstname: string;
  lastname: string;
  email: string;
  customFields: CustomFieldInput[];
}

/**
 * Wire payload for a slot claim.
 *
 * Mirrors `objForm` + the `d.ProcessSignUp` additions. `siid` is an array here
 * (the RSVP path sends the empty string) and `items` replaces the RSVP path's
 * `slotid`/`rsvp*` fields.
 */
export interface ClaimPayload {
  listid: number;
  owner: number;
  urlid: string;
  title: string;
  siid: string[];
  rsvpid: number;
  imid: number;
  usealternatename: boolean;
  /** Misspelled in SignUpGenius's own wizard — preserve the typo. */
  changemembermame: boolean;
  displayfirstname: string;
  displaylastname: string;
  firstname: string;
  lastname: string;
  email: string;
  optInStatus: boolean;
  savecontactinfo: boolean;
  type: 'standard';
  source: 'main';
  items: Array<Record<string, unknown>>;
  isLoggedin: true;
  payLater: false;
  customFields: CustomFieldInput[];
}

/** Build the claim payload. Pure / testable. */
export function buildClaimPayload(
  parts: SignUpUrlParts,
  info: ClaimSignupInfo,
  items: FormItem[],
  input: ClaimInput,
): ClaimPayload {
  return {
    listid: info.id,
    owner: info.owner,
    urlid: parts.urlid,
    title: info.title,
    siid: [String(input.slotitemid)],
    rsvpid: 0,
    imid: 0,
    usealternatename: false,
    changemembermame: false,
    // The wizard copies objForm.firstname/lastname into the display fields
    // whenever usealternatename is false, which is the case here.
    displayfirstname: input.firstname,
    displaylastname: input.lastname,
    firstname: input.firstname,
    lastname: input.lastname,
    email: input.email,
    optInStatus: false,
    savecontactinfo: false,
    type: 'standard',
    source: 'main',
    // The wizard sends the item rows back with the user's chosen quantity and
    // comment merged in; keys are lower-cased client-side by `lowerCaseKeys`.
    items: items.map((it) => ({
      ...lowerCaseKeys(it as Record<string, unknown>),
      myqty: input.quantity,
      mycomment: input.comment ?? '',
    })),
    isLoggedin: true,
    payLater: false,
    customFields: input.customFields,
  };
}

/** Lower-case every top-level key, matching the wizard's `lowerCaseKeys`. */
export function lowerCaseKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k.toLowerCase()] = v;
  return out;
}

const claimSchema = z.object({
  url: z.string().min(1).describe('Sign-up URL or slug.'),
  slotitemid: z
    .number()
    .int()
    .positive()
    .describe('The slot to claim. Get this from signupgenius_list_slots.'),
  quantity: z.number().int().min(1).max(99).optional().describe('Spots to take. Default 1.'),
  comment: z.string().max(500).optional().describe('Optional comment shown to the organizer.'),
  firstname: z.string().min(1),
  lastname: z.string().min(1),
  email: z.string().email(),
  customFields: z
    .array(
      z.object({
        fieldtype: z.string().min(1),
        fieldname: z.string().optional(),
        myvalue: z.string(),
      }),
    )
    .optional()
    .describe(
      'Answers to the sheet\'s required custom questions. Read the required set from ' +
        'signupgenius_get_public_signup.customFields — omitting a required field makes ' +
        'the server reject the claim.',
    ),
  confirm: z
    .boolean()
    .optional()
    .describe(
      'Must be true to actually submit. Omit (or false) to get a dry-run preview of ' +
        'exactly what would be sent, including the identity and the slot.',
    ),
});

const releaseSchema = z.object({
  url: z.string().min(1).describe('Sign-up URL or slug.'),
  itemMemberId: z
    .number()
    .int()
    .positive()
    .describe(
      'The sign-up entry to withdraw — `participants[].item_member_id` from ' +
        'signupgenius_list_slots. This is the wizard\'s `imid`.',
    ),
  memberId: z
    .number()
    .int()
    .positive()
    .describe('Your SignUpGenius member id (signupgenius_get_profile).'),
  confirm: z.boolean().optional().describe('Must be true to actually withdraw.'),
});

export function registerSlotWriteTools(server: McpServer, client: SignUpGeniusClient): void {
  // Both writes ride the browser session (JWT + ColdFusion cookies). The Pro
  // v2/k key API has no equivalent, so registering them in key mode would
  // advertise something that can never run.
  if (client.mode !== 'session') return;

  server.registerTool(
    'signupgenius_claim_slot',
    {
      description:
        'Claim (sign up for) a slot on a slot-based SignUpGenius sheet. ' +
        'Two-step by design: call WITHOUT `confirm` first to get a preview of the ' +
        'slot, identity and payload, show it to the user, then call again with ' +
        'confirm:true. WRITES DATA — never call with confirm:true unless the user ' +
        'has explicitly approved this specific slot. For Yes/No/Maybe headcount ' +
        'sheets use signupgenius_rsvp instead.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: claimSchema.shape,
    },
    async (raw) => {
      const args = claimSchema.parse(raw);
      const parts = parseSignUpUrl(args.url);
      const quantity = args.quantity ?? 1;

      const infoRes = await client.request<ClaimSignupInfo>('', {
        legacyAction: 's.getSignupInfo',
        body: { urlid: parts.urlid },
      });
      const info = infoRes.data;
      if (Number(info.useRSVP) === 1) {
        throw new Error(
          `Sign-up ${parts.urlid} is an RSVP-style (Yes/No/Maybe) sheet, not a slot-based one. ` +
            'Use signupgenius_rsvp instead of signupgenius_claim_slot.',
        );
      }

      const itemsRes = await client.request<FormItem[]>('', {
        legacyAction: 's.getSignUpFormItems',
        body: {
          listid: info.id,
          siid: [String(args.slotitemid)],
          hasProductImages: false,
        },
      });
      const items = Array.isArray(itemsRes.data) ? itemsRes.data : [];
      if (items.length === 0) {
        throw new Error(
          `Slot item ${args.slotitemid} was not found on sign-up ${parts.urlid}. ` +
            'Re-read signupgenius_list_slots — slot ids change when the organizer edits the sheet.',
        );
      }
      const item = items[0];
      const available = item.AVAILABLEQTY ?? 0;
      if (available < quantity) {
        throw new Error(
          `Slot item ${args.slotitemid} has only ${available} spot(s) left but ${quantity} ` +
            'were requested. Re-check availability with signupgenius_list_slots.',
        );
      }

      const payload = buildClaimPayload(parts, info, items, {
        slotitemid: args.slotitemid,
        quantity,
        comment: args.comment,
        firstname: args.firstname,
        lastname: args.lastname,
        email: args.email,
        customFields: args.customFields ?? [],
      });

      const preview = {
        action: 'claim',
        signupid: parts.signupid,
        title: info.title,
        slot: {
          slotitemid: args.slotitemid,
          label: item.ITEM,
          starttime: item.STARTTIME,
          endtime: item.ENDTIME,
          location: item.LOCATION,
          availableBefore: available,
        },
        signingUpAs: `${args.firstname} ${args.lastname} <${args.email}>`,
        quantity,
        comment: args.comment ?? '',
        customFields: payload.customFields,
      };

      if (!args.confirm) {
        return textContent({
          ...preview,
          submitted: false,
          note:
            'DRY RUN — nothing was written. Show this to the user and call again with ' +
            'confirm:true to submit.',
        });
      }

      // Establishes the ColdFusion-session pointer the dispatcher requires
      // before it will accept a submission for this sign-up.
      await client.preProcessSignUp(parts.urlid);

      const result = await client.request('', {
        legacyAction: 's.processSignUpFormHandler',
        body: payload,
      });
      if (!result.success) {
        const detail = result.message.length > 0 ? result.message.join('; ') : 'unknown';
        throw new Error(
          `Slot claim failed: ${detail}. If this mentions a missing field, read ` +
            'signupgenius_get_public_signup.customFields and resend with every required answer.',
        );
      }
      return textContent({ ...preview, submitted: true, server: result.data });
    },
  );

  server.registerTool(
    'signupgenius_release_slot',
    {
      description:
        'Withdraw (give up) a slot the user previously signed up for. ' +
        'Call WITHOUT `confirm` first to preview which entry would be removed, ' +
        'then again with confirm:true. WRITES DATA — this removes a real sign-up.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: releaseSchema.shape,
    },
    async (raw) => {
      const args = releaseSchema.parse(raw);
      const parts = parseSignUpUrl(args.url);

      const preview = {
        action: 'release',
        signupid: parts.signupid,
        urlid: parts.urlid,
        itemMemberId: args.itemMemberId,
        memberId: args.memberId,
      };
      if (!args.confirm) {
        return textContent({
          ...preview,
          submitted: false,
          note:
            'DRY RUN — nothing was removed. Confirm the participant entry with the user ' +
            '(signupgenius_list_slots shows item_member_id per person), then call again ' +
            'with confirm:true.',
        });
      }

      await client.deletePerson(parts.signupid, args.itemMemberId, args.memberId);
      return textContent({ ...preview, submitted: true });
    },
  );
}
