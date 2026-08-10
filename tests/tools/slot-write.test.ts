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
  const { client, handlers } = setupTools(
    registerSlotWriteTools,
    sessionAccount,
    (_path: string, opts: unknown) => {
      const o = opts as { legacyAction: string; body: unknown };
      seen.push({ action: o.legacyAction, body: o.body });
      if (o.legacyAction === 's.getSignupInfo') {
        return { success: true, message: [], data: 'info' in over ? over.info : INFO };
      }
      if (o.legacyAction === 's.getSignUpFormItems') {
        return { success: true, message: [], data: 'items' in over ? over.items : [ITEM] };
      }
      return 'submit' in over ? over.submit : { success: true, message: [], data: { ok: 1 } };
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

  it('treats a missing AVAILABLEQTY as no room', async () => {
    const { handlers } = claimSetup({ items: [{ ...ITEM, AVAILABLEQTY: undefined }] });
    await expect(handlers.get('signupgenius_claim_slot')!(CLAIM)).rejects.toThrow(/only 0 spot/);
  });

  it('treats a non-array items payload as "not found"', async () => {
    const { handlers } = claimSetup({ items: null });
    await expect(handlers.get('signupgenius_claim_slot')!(CLAIM)).rejects.toThrow(/was not found/);
  });

  it('surfaces a server rejection with the custom-field hint', async () => {
    const { handlers } = claimSetup({
      submit: { success: false, message: ['key [PHONE] doesn’t exist'], data: null },
    });
    await expect(
      handlers.get('signupgenius_claim_slot')!({ ...CLAIM, confirm: true }),
    ).rejects.toThrow(/Slot claim failed.*PHONE.*customFields/s);
  });

  it('reports "unknown" when a rejection carries no message', async () => {
    const { handlers } = claimSetup({ submit: { success: false, message: [], data: null } });
    await expect(
      handlers.get('signupgenius_claim_slot')!({ ...CLAIM, confirm: true }),
    ).rejects.toThrow(/unknown/);
  });
});

describe('signupgenius_release_slot', () => {
  const REL = { url: PARTS.urlid, itemMemberId: 1381103237, memberId: 4262737 };

  it('previews without removing anything', async () => {
    const { handlers, del } = claimSetup();
    const out = JSON.parse((await handlers.get('signupgenius_release_slot')!(REL)).content[0].text);
    expect(out.submitted).toBe(false);
    expect(out.note).toMatch(/DRY RUN/);
    expect(del).not.toHaveBeenCalled();
  });

  it('removes the entry when confirmed', async () => {
    const { handlers, del } = claimSetup();
    const out = JSON.parse(
      (await handlers.get('signupgenius_release_slot')!({ ...REL, confirm: true })).content[0].text,
    );
    expect(out.submitted).toBe(true);
    expect(del).toHaveBeenCalledWith(62393618, 1381103237, 4262737);
  });
});
