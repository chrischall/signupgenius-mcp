import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildClaimPayload,
  lowerCaseKeys,
  registerSlotWriteTools,
  type FormItem,
} from '../../src/tools/slot-write.js';
import { parseSignUpUrl } from '../../src/tools/public-signup.js';
import { setupTools, sessionAccount, keyAccount } from './_setup.js';

afterEach(() => vi.restoreAllMocks());

const PARTS = parseSignUpUrl('10C0849AAAA2EA4FD0-62393618-20262027');
const INFO = { id: 62393618, owner: 15465560, title: 'Chaperones', useRSVP: 0 };

/** A verbatim row from the live s.getSignUpFormItems response. */
const ITEM: FormItem = {
  ITEM: 'Chaperone',
  QTY: 4,
  AVAILABLEQTY: 1,
  ENDTIME: 'September, 11 2026 22:00:00',
  STARTTIME: 'September, 11 2026 18:00:00',
  SLOTID: 801652087,
  SLOTITEMID: 1762735186,
  LOCATION: 'Football Home vs. Mallard Creek',
};

const CLAIM = {
  url: '10C0849AAAA2EA4FD0-62393618-20262027',
  slotitemid: 1762735186,
  firstname: 'Chris',
  lastname: 'Hall',
  email: 'chris@example.com',
};

describe('lowerCaseKeys', () => {
  it('lower-cases every top-level key, matching the wizard helper', () => {
    expect(lowerCaseKeys({ AB: 1, cD: 2 })).toEqual({ ab: 1, cd: 2 });
  });
});

describe('buildClaimPayload', () => {
  const payload = buildClaimPayload(PARTS, INFO, [ITEM], {
    slotitemid: 1762735186,
    quantity: 2,
    comment: 'bringing a friend',
    firstname: 'Chris',
    lastname: 'Hall',
    email: 'chris@example.com',
    customFields: [{ fieldtype: 'Phone', fieldname: 'Phone', myvalue: '704-555-0100' }],
  });

  it('marks the submission as a slot claim, not an RSVP', () => {
    expect(payload.type).toBe('standard');
    expect(payload.source).toBe('main');
  });

  it('sends siid as an ARRAY of slot-item ids', () => {
    // Captured from the live objForm: siid is an array even for one slot.
    expect(payload.siid).toEqual(['1762735186']);
  });

  it('preserves SignUpGenius’s own misspelling of changemembermame', () => {
    expect(payload).toHaveProperty('changemembermame', false);
    expect(payload).not.toHaveProperty('changemembername');
  });

  it('merges the chosen quantity and comment into lower-cased item rows', () => {
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({
      slotitemid: 1762735186,
      item: 'Chaperone',
      myqty: 2,
      mycomment: 'bringing a friend',
    });
    // Upper-case wire keys must not survive alongside the lower-cased ones.
    expect(payload.items[0]).not.toHaveProperty('SLOTITEMID');
  });

  it('mirrors the identity into the display fields', () => {
    expect(payload.displayfirstname).toBe('Chris');
    expect(payload.displaylastname).toBe('Hall');
    expect(payload.usealternatename).toBe(false);
    expect(payload.isLoggedin).toBe(true);
    expect(payload.payLater).toBe(false);
  });

  it('carries the custom-field answers through', () => {
    expect(payload.customFields).toEqual([
      { fieldtype: 'Phone', fieldname: 'Phone', myvalue: '704-555-0100' },
    ]);
  });

  it('defaults the comment to an empty string', () => {
    const p = buildClaimPayload(PARTS, INFO, [ITEM], {
      slotitemid: 1,
      quantity: 1,
      firstname: 'A',
      lastname: 'B',
      email: 'a@b.c',
      customFields: [],
    });
    expect(p.items[0]).toMatchObject({ mycomment: '' });
  });
});

describe('registration gating', () => {
  it('does not register the write tools outside session mode', () => {
    const { handlers } = setupTools(registerSlotWriteTools, keyAccount);
    expect(handlers.size).toBe(0);
  });

  it('defaults to the real global fetch for the public checks', async () => {
    // index.ts registers without a fetcher, so the default arm is the
    // production path — exercise it rather than leaving it untested.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ SUCCESS: true, MESSAGE: [], DATA: { participants: [] } }),
    } as never);
    const { handlers } = setupTools(registerSlotWriteTools, sessionAccount, () => ({
      success: true,
      message: [],
      data: { id: 1 },
    }));
    await expect(
      handlers.get('signupgenius_release_slot')!({
        url: PARTS.urlid,
        itemMemberId: 1,
        slotitemid: 2,
      }),
    ).rejects.toThrow(/No sign-up entry/);
    expect(spy).toHaveBeenCalled();
  });

  it('registers both tools in session mode', () => {
    const { handlers } = setupTools(registerSlotWriteTools, sessionAccount);
    expect([...handlers.keys()].sort()).toEqual([
      'signupgenius_claim_slot',
      'signupgenius_release_slot',
    ]);
  });
});

/** Route the legacy actions the claim flow walks. */
function claimSetup(over: Record<string, unknown> = {}) {
  const seen: Array<{ action: string; body: unknown }> = [];
  // Public participants endpoint, used for the ownership + read-back checks.
  // Default: the entry under test belongs to the signed-in member (4262737).
  const pages: unknown[] = Array.isArray(over.participantPages)
    ? (over.participantPages as unknown[])
    : [
        [{ firstname: 'Chris', lastname: 'Hall', myqty: 1, itemmemberid: 2000004, memberid: 4262737 }],
      ];
  let pageIdx = 0;
  let fetchCalls = 0;
  const publicFetcher = async () => {
    if (over.participantsThrow) throw new Error('participants unavailable');
    fetchCalls++;
    // Fail only the post-delete read-back, not the ownership lookup.
    if (typeof over.participantsThrowAfter === 'number' && fetchCalls > over.participantsThrowAfter) {
      throw new Error('network');
    }
    const rows = pages[Math.min(pageIdx, pages.length - 1)] ?? [];
    pageIdx++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ SUCCESS: true, MESSAGE: [], DATA: { participants: rows } }),
    };
  };
  const { client, handlers } = setupTools(
    (server, c) => registerSlotWriteTools(server, c, publicFetcher as never),
    sessionAccount,
    (path: string, opts: unknown) => {
      const o = (opts ?? {}) as { legacyAction?: string; body?: unknown };
      if (!o.legacyAction) {
        // client.request('/member/profile') — identity for the ownership check.
        seen.push({ action: `GET ${path}`, body: undefined });
        if ('profile' in over) {
          const p = over.profile as { throws?: boolean; data?: unknown };
          if (p?.throws) throw new Error('profile unavailable');
          return { success: true, message: [], data: p?.data };
        }
        return { success: true, message: [], data: { id: 4262737 } };
      }
      seen.push({ action: o.legacyAction, body: o.body });
      if (o.legacyAction === 's.getSignupInfo') {
        return { success: true, message: [], data: 'info' in over ? over.info : INFO };
      }
      if (o.legacyAction === 's.getSignUpFormItems') {
        return { success: true, message: [], data: 'items' in over ? over.items : [ITEM] };
      }
      if ('submitThrowsRaw' in over) throw 'plain-string failure';
      if ('submitThrows' in over) throw new Error(over.submitThrows as string);
      return { success: true, message: [], data: { ok: 1 } };
    },
  );
  const pre = vi.spyOn(client, 'preProcessSignUp').mockResolvedValue(undefined);
  const del = vi.spyOn(client, 'deletePerson').mockResolvedValue(undefined);
  return { handlers, seen, pre, del };
}

describe('signupgenius_claim_slot', () => {
  it('previews without writing when confirm is absent', async () => {
    const { handlers, seen, pre } = claimSetup();
    const res = await handlers.get('signupgenius_claim_slot')!(CLAIM);
    const out = JSON.parse(res.content[0].text);

    expect(out.submitted).toBe(false);
    expect(out.note).toMatch(/DRY RUN/);
    expect(out.slot).toMatchObject({ label: 'Chaperone', availableBefore: 1 });
    expect(out.signingUpAs).toBe('Chris Hall <chris@example.com>');
    // Nothing that mutates state was called.
    expect(pre).not.toHaveBeenCalled();
    expect(seen.map((s) => s.action)).toEqual(['s.getSignupInfo', 's.getSignUpFormItems']);
  });

  it('submits only when confirm is true, after PreProcessSignup', async () => {
    const { handlers, seen, pre } = claimSetup();
    const res = await handlers.get('signupgenius_claim_slot')!({ ...CLAIM, confirm: true });
    const out = JSON.parse(res.content[0].text);

    expect(out.submitted).toBe(true);
    expect(pre).toHaveBeenCalledWith(PARTS.urlid);
    const submit = seen.find((s) => s.action === 's.processSignUpFormHandler')!;
    expect(submit.body).toMatchObject({ type: 'standard', siid: ['1762735186'] });
  });

  it('queries form items with a real slot-item id, not an empty selection', async () => {
    const { handlers, seen } = claimSetup();
    await handlers.get('signupgenius_claim_slot')!(CLAIM);
    const items = seen.find((s) => s.action === 's.getSignUpFormItems')!;
    // siid: 0 / "" / [] all mean "nothing selected" and return no rows.
    expect(items.body).toMatchObject({ listid: 62393618, siid: ['1762735186'] });
  });

  it('refuses an RSVP-style sheet and points at the right tool', async () => {
    const { handlers } = claimSetup({ info: { ...INFO, useRSVP: 1 } });
    await expect(handlers.get('signupgenius_claim_slot')!(CLAIM)).rejects.toThrow(
      /RSVP-style .* Use signupgenius_rsvp/s,
    );
  });

  it('refuses when the slot id no longer resolves', async () => {
    const { handlers } = claimSetup({ items: [] });
    await expect(handlers.get('signupgenius_claim_slot')!(CLAIM)).rejects.toThrow(
      /was not found/,
    );
  });

  it('refuses to overbook a slot', async () => {
    const { handlers } = claimSetup();
    await expect(
      handlers.get('signupgenius_claim_slot')!({ ...CLAIM, quantity: 3 }),
    ).rejects.toThrow(/only 1 spot\(s\) left but 3/);
  });

  it('allows a slot whose availability is unreported (unlimited rows)', async () => {
    // Coercing a missing AVAILABLEQTY to 0 made unlimited slots permanently
    // unclaimable, with an error that said the opposite of the truth.
    const { handlers } = claimSetup({ items: [{ ...ITEM, AVAILABLEQTY: undefined }] });
    const out = JSON.parse(
      (await handlers.get('signupgenius_claim_slot')!(CLAIM)).content[0].text,
    );
    expect(out.submitted).toBe(false);
    expect(out.slot.availableBefore).toBe('unlimited/unreported');
  });

  it('refuses when one slotitemid resolves to several form rows', async () => {
    const { handlers } = claimSetup({ items: [ITEM, { ...ITEM, SLOTITEMID: 999 }] });
    await expect(handlers.get('signupgenius_claim_slot')!(CLAIM)).rejects.toThrow(
      /resolved to 2 form rows/,
    );
  });

  it('treats a non-array items payload as "not found"', async () => {
    const { handlers } = claimSetup({ items: null });
    await expect(handlers.get('signupgenius_claim_slot')!(CLAIM)).rejects.toThrow(/was not found/);
  });

  it('handles a non-Error rejection value', async () => {
    const { handlers } = claimSetup({ submitThrowsRaw: true });
    await expect(
      handlers.get('signupgenius_claim_slot')!({ ...CLAIM, confirm: true }),
    ).rejects.toThrow(/Slot claim failed: plain-string failure/);
  });

  it('attaches the custom-field hint to a THROWN server rejection', async () => {
    // The real client throws on a success:false envelope, so a
    // `if (!result.success)` check would be dead code and this guidance —
    // the most likely rejection — would never reach the caller.
    const { handlers } = claimSetup({
      submit: undefined,
      submitThrows: 'SignUpGenius error: key [PHONE] doesn’t exist',
    });
    await expect(
      handlers.get('signupgenius_claim_slot')!({ ...CLAIM, confirm: true }),
    ).rejects.toThrow(/Slot claim failed.*PHONE.*customFields/s);
  });
});

describe('signupgenius_release_slot', () => {
  const REL = { url: PARTS.urlid, itemMemberId: 2000004, slotitemid: 1762735194 };
  const MINE = { firstname: 'Chris', lastname: 'Hall', myqty: 1, itemmemberid: 2000004, memberid: 4262737 };

  it('previews without removing anything, naming who is being withdrawn', async () => {
    const { handlers, del } = claimSetup();
    const out = JSON.parse((await handlers.get('signupgenius_release_slot')!(REL)).content[0].text);
    expect(out.submitted).toBe(false);
    expect(out.note).toMatch(/DRY RUN/);
    expect(out.withdrawing).toEqual({ name: 'Chris Hall', spots: 1 });
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses an entry belonging to another participant, with NO memberId given', async () => {
    // The default path: memberId is optional, so resolving only OUR id left
    // itemMemberId completely unverified. list_slots publishes every
    // participant's item_member_id, so a mis-picked row must not delete a
    // stranger's sign-up.
    const { handlers, del } = claimSetup({
      participantPages: [
        [{ firstname: 'Someone', lastname: 'Else', myqty: 1, itemmemberid: 2000004, memberid: 987654 }],
      ],
    });
    await expect(handlers.get('signupgenius_release_slot')!({ ...REL, confirm: true })).rejects.toThrow(
      /belongs to member 987654, not the signed-in member \(4262737\)/,
    );
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses a guest entry that is not tied to a member account', async () => {
    const { handlers, del } = claimSetup({
      participantPages: [[{ nonmembername: 'Guest', myqty: 1, itemmemberid: 2000004, memberid: 0 }]],
    });
    await expect(handlers.get('signupgenius_release_slot')!(REL)).rejects.toThrow(
      /not tied to a member account/,
    );
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses when the entry is not on that slot at all', async () => {
    const { handlers, del } = claimSetup({ participantPages: [[]] });
    await expect(handlers.get('signupgenius_release_slot')!(REL)).rejects.toThrow(
      /No sign-up entry 2000004 is listed on slot 1762735194/,
    );
    expect(del).not.toHaveBeenCalled();
  });

  it('still rejects an explicitly mismatched memberId before any lookup', async () => {
    const { handlers, del } = claimSetup();
    await expect(
      handlers.get('signupgenius_release_slot')!({ ...REL, memberId: 999999, confirm: true }),
    ).rejects.toThrow(/not the signed-in member/);
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses when the signed-in member id cannot be determined', async () => {
    const { handlers, del } = claimSetup({ profile: { data: {} } });
    await expect(handlers.get('signupgenius_release_slot')!(REL)).rejects.toThrow(
      /cannot be verified/,
    );
    expect(del).not.toHaveBeenCalled();
  });

  it('accepts a profile that reports memberid instead of id', async () => {
    const { handlers } = claimSetup({ profile: { data: { memberid: 4262737 } } });
    const out = JSON.parse((await handlers.get('signupgenius_release_slot')!(REL)).content[0].text);
    expect(out.memberId).toBe(4262737);
  });

  it('removes and verifies the entry disappeared', async () => {
    const { handlers, del } = claimSetup({ participantPages: [[MINE], []] });
    const out = JSON.parse(
      (await handlers.get('signupgenius_release_slot')!({ ...REL, confirm: true })).content[0].text,
    );
    expect(del).toHaveBeenCalledWith(62393618, 2000004, 4262737);
    expect(out.submitted).toBe(true);
    expect(out.verified).toMatch(/no longer listed/);
  });

  it('reports a still-listed entry without claiming nothing was removed', async () => {
    const { handlers } = claimSetup({ participantPages: [[MINE], [MINE]] });
    const err = await handlers
      .get('signupgenius_release_slot')!({ ...REL, confirm: true })
      .catch((e: Error) => e);
    expect(err.message).toMatch(/still listed on the slot/);
    // The delete reported success and the read-back may be stale, so the
    // message must not assert that nothing happened.
    expect(err.message).not.toMatch(/Nothing was removed/);
  });

  it('reports an unverifiable removal without failing it', async () => {
    const { handlers, del } = claimSetup({ participantsThrowAfter: 1 });
    const out = JSON.parse(
      (await handlers.get('signupgenius_release_slot')!({ ...REL, confirm: true })).content[0].text,
    );
    expect(del).toHaveBeenCalled();
    expect(out.submitted).toBe(true);
    expect(out.verified).toMatch(/could not re-check/);
  });

  it('surfaces a failed ownership lookup rather than deleting blind', async () => {
    const { handlers, del } = claimSetup({ participantsThrow: true });
    await expect(handlers.get('signupgenius_release_slot')!(REL)).rejects.toThrow(
      /participants unavailable/,
    );
    expect(del).not.toHaveBeenCalled();
  });
});
