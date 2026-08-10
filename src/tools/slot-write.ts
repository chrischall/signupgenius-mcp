import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SignUpGeniusClient } from '../client.js';
import { textContent } from './_shared.js';
import { parseSignUpUrl, type SignUpUrlParts } from './public-signup.js';
import type { Fetcher } from './sug-legacy.js';
import { fetchAllParticipants } from './slots.js';

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
  slotitemid: z
    .number()
    .int()
    .positive()
    .describe(
      'The slot the entry sits in (`slotitemid` from the same signupgenius_list_slots row). ' +
        'Used to verify afterwards that the entry actually disappeared.',
    ),
  memberId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Optional. The signed-in member id is resolved automatically; supplying a DIFFERENT ' +
        'one is rejected, because this tool only withdraws the current user\'s own sign-up.',
    ),
  confirm: z.boolean().optional().describe('Must be true to actually withdraw.'),
});

export function registerSlotWriteTools(
  server: McpServer,
  client: SignUpGeniusClient,
  /** Public (unauthenticated) fetch used for the ownership + read-back checks. */
  fetcher: Fetcher = (url, init) => globalThis.fetch(url, init),
): void {
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
      // #8: the payload stamps `myqty` onto EVERY returned row, so validating
      // only items[0] would let a second row through unchecked.
      if (items.length > 1) {
        throw new Error(
          `Slot item ${args.slotitemid} resolved to ${items.length} form rows, but a claim ` +
            'may only take one. Claim each slot in a separate call.',
        );
      }
      const item = items[0];
      // Only enforce when a finite figure came back. Coercing a missing
      // AVAILABLEQTY to 0 made unlimited slots permanently unclaimable, with
      // an error that said the opposite of the truth.
      const available = item.AVAILABLEQTY;
      if (typeof available === 'number' && Number.isFinite(available) && available < quantity) {
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
          availableBefore: available ?? 'unlimited/unreported',
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

      // `client.request` -> `parseEnvelope` THROWS on a `success:false`
      // envelope, so a `if (!result.success)` check here would be dead code and
      // the custom-field remediation would never reach the caller — which is
      // the single most likely rejection ("key [PHONE] doesn't exist").
      // Catch and re-throw with the guidance attached.
      let result;
      try {
        result = await client.request('', {
          legacyAction: 's.processSignUpFormHandler',
          body: payload,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Slot claim failed: ${detail}. If this mentions a missing or unknown field, read ` +
            'signupgenius_get_public_signup.customFields and resend with every required answer ' +
            '(this sheet\'s required set is reported there).',
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

      // Resolve WHO we are from the session rather than trusting the caller.
      // signupgenius_list_slots publishes every participant's item_member_id
      // and member_id for any public sheet, so a model that picked the wrong
      // row could otherwise ask us to withdraw a stranger's sign-up. The
      // server's authorization for s.DeletePerson is unverified (this path was
      // deliberately never exercised), so enforce ownership client-side too.
      const profileRes = await client.request<{ id?: number; memberid?: number }>(
        '/member/profile',
      );
      const myId = profileRes.data?.id ?? profileRes.data?.memberid;
      if (typeof myId !== 'number') {
        throw new Error(
          'Could not determine the signed-in member id from signupgenius_get_profile, ' +
            'so ownership of this sign-up entry cannot be verified. Refusing to withdraw it.',
        );
      }
      if (args.memberId !== undefined && args.memberId !== myId) {
        throw new Error(
          `Refusing to withdraw: memberId ${args.memberId} is not the signed-in member (${myId}). ` +
            'This tool only removes the current user\'s own sign-up. To remove someone else, ' +
            'the sign-up owner must do it in the SignUpGenius UI.',
        );
      }

      // Resolving OUR id is not enough — `memberId` is optional, so on the
      // normal path nothing would have tied `itemMemberId` to us. Look the
      // entry up on the slot and check who it actually belongs to. This is the
      // guard that matters: signupgenius_list_slots publishes every
      // participant's item_member_id and member_id for any public sheet, so a
      // mis-picked row is a realistic way to delete a stranger's sign-up.
      const entries = await fetchAllParticipants(fetcher, parts.signupid, args.slotitemid);
      const entry = entries.find((p) => p.item_member_id === args.itemMemberId);
      if (!entry) {
        throw new Error(
          `No sign-up entry ${args.itemMemberId} is listed on slot ${args.slotitemid}. ` +
            'It may already have been withdrawn, or the ids may be from different rows — ' +
            're-read signupgenius_list_slots and use item_member_id and slotitemid from the SAME row.',
        );
      }
      if (entry.member_id === undefined) {
        throw new Error(
          `Sign-up entry ${args.itemMemberId} ("${entry.display_name}") is not tied to a member ` +
            'account, so it cannot be confirmed as the signed-in user\'s. Refusing to withdraw it — ' +
            'remove a guest sign-up from the SignUpGenius UI instead.',
        );
      }
      if (entry.member_id !== myId) {
        throw new Error(
          `Refusing to withdraw: sign-up entry ${args.itemMemberId} ("${entry.display_name}") ` +
            `belongs to member ${entry.member_id}, not the signed-in member (${myId}). ` +
            'This tool only removes the current user\'s own sign-up.',
        );
      }

      const preview = {
        action: 'release',
        signupid: parts.signupid,
        urlid: parts.urlid,
        itemMemberId: args.itemMemberId,
        slotitemid: args.slotitemid,
        memberId: myId,
        withdrawing: { name: entry.display_name, spots: entry.quantity },
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

      await client.deletePerson(parts.signupid, args.itemMemberId, myId);

      // Verify rather than trust the status code: s.DeletePerson answers HTML,
      // so a "success" is only meaningful if the entry is actually gone.
      let verified: boolean | null = null;
      try {
        const remaining = await fetchAllParticipants(fetcher, parts.signupid, args.slotitemid);
        verified = !remaining.some((p) => p.item_member_id === args.itemMemberId);
      } catch {
        // Verification is best-effort; never turn a successful withdrawal into
        // a failure because the read-back call had a bad minute.
        verified = null;
      }
      if (verified === false) {
        // Deliberately does NOT claim "nothing was removed": the delete
        // reported success and this read-back may simply be stale. State only
        // what was observed.
        throw new Error(
          `SignUpGenius accepted the withdrawal of entry ${args.itemMemberId}, but it is still ` +
            'listed on the slot. The removal may not have taken effect — check the sheet in the UI ' +
            'before retrying.',
        );
      }
      return textContent({
        ...preview,
        submitted: true,
        verified: verified === true ? 'entry no longer listed on the slot' : 'could not re-check',
      });
    },
  );
}
