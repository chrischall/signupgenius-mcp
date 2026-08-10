import { describe, it, expect, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  resolveSignUpId,
  splitTimestamp,
  extractSlots,
  toParticipant,
  fetchParticipants,
  registerSlotTools,
} from '../../src/tools/slots.js';
import type { Fetcher } from '../../src/tools/sug-legacy.js';
import SLOTS from '../fixtures/slots.json' with { type: 'json' };
import PARTICIPANTS from '../fixtures/participants.json' with { type: 'json' };

afterEach(() => vi.restoreAllMocks());

/**
 * Route the two endpoints the tool uses. Both fixtures are verbatim captures
 * from the live unauthenticated APIs.
 */
function routed(over: { slots?: unknown; participants?: unknown } = {}) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push(url);
    const body = url.includes('/slots') ? over.slots ?? SLOTS : over.participants ?? PARTICIPANTS;
    void init;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetcher, calls };
}

describe('resolveSignUpId', () => {
  it('accepts a bare id, a slug, and a full URL', () => {
    expect(resolveSignUpId('62393618')).toBe(62393618);
    expect(resolveSignUpId(' 10C0849AAAA2EA4FD0-62393618-20262027 ')).toBe(62393618);
    expect(resolveSignUpId('https://www.signupgenius.com/go/ABC-777-x')).toBe(777);
  });
});

describe('splitTimestamp', () => {
  it('splits a timed slot into date, weekday and clock time', () => {
    expect(splitTimestamp('2026-08-21T17:00:00')).toEqual({
      date: '2026-08-21',
      day_of_week: 'Friday',
      time: '17:00',
    });
  });

  it('treats a midnight timestamp as date-only (the "time TBD" rows)', () => {
    expect(splitTimestamp('2026-09-26T00:00:00')).toEqual({
      date: '2026-09-26',
      day_of_week: 'Saturday',
      time: null,
    });
  });

  it('does not shift the date across timezones', () => {
    // Parsed as literal fields, never through local-time Date parsing — a
    // 00:00 stamp in a negative-offset zone would otherwise roll back a day.
    expect(splitTimestamp('2026-01-01T00:00:00').date).toBe('2026-01-01');
    expect(splitTimestamp('2026-01-01T00:00:00').day_of_week).toBe('Thursday');
  });

  it('handles null, undefined and unparseable input', () => {
    for (const v of [null, undefined, 'later']) {
      expect(splitTimestamp(v)).toEqual({ date: '', day_of_week: '', time: null });
    }
  });

  it('accepts a date with no time component', () => {
    expect(splitTimestamp('2026-03-04')).toEqual({
      date: '2026-03-04',
      day_of_week: 'Wednesday',
      time: null,
    });
  });
});

describe('extractSlots (real captured v3 payload)', () => {
  const slots = extractSlots(SLOTS as never);

  it('flattens every slot item', () => {
    expect(slots).toHaveLength(5);
    expect(slots[0].slot_label).toBe('Chaperone');
  });

  it('reads capacity/filled/available and full state', () => {
    expect(slots[0]).toMatchObject({
      date: '2026-08-21',
      day_of_week: 'Friday',
      start_time: '17:00',
      end_time: '22:00',
      capacity: 6,
      filled_count: 6,
      available_count: 0,
      is_full: true,
    });
  });

  it('keeps the row headline and the venue separate', () => {
    expect(slots[0].title).toBe('Football Away @ Providence Day');
    expect(slots[0].location).toBe('Providence Day');
  });

  it('reports filled_count from quantity, not from the head-count of people', () => {
    // 10/24/2026 renders as "4 of 6 filled" across only THREE name entries,
    // because one of them consumes 2 spots. Counting names undercounts.
    const oct24 = slots.find((s) => s.date === '2026-10-24')!;
    expect(oct24.filled_count).toBe(4);
    expect(oct24.participant_count).toBe(3);
    expect(oct24.available_count).toBe(2);
    expect(oct24.is_full).toBe(false);
  });

  it('surfaces date-only rows with a null time', () => {
    const tbd = slots.find((s) => s.date === '2026-09-26')!;
    expect(tbd.start_time).toBeNull();
    expect(tbd.end_time).toBeNull();
    expect(tbd.day_of_week).toBe('Saturday');
  });

  it('reports the owner hidenames preference', () => {
    expect(slots[0].names_hidden).toBe(true);
  });

  it('tolerates an empty / malformed envelope and missing fields', () => {
    expect(extractSlots({})).toEqual([]);
    expect(extractSlots({ data: { slots: [{}] } })).toEqual([]);
    const [only] = extractSlots({ data: { slots: [{ slotitems: [{}] }] } });
    expect(only).toMatchObject({
      slot_label: '(untitled slot)',
      slotid: 0,
      slotitemid: 0,
      capacity: null,
      filled_count: 0,
      is_full: false,
      participant_count: 0,
      names_hidden: false,
    });
    expect(only.title).toBeUndefined();
    expect(only.location).toBeUndefined();
  });

  it('reports unlimited slots as capacity-less rather than zero-remaining', () => {
    const [u] = extractSlots({
      data: { slots: [{ slotitems: [{ quantity: { unlimited: true, limit: null, taken: 3 } }] }] },
    });
    expect(u.unlimited).toBe(true);
    expect(u.capacity).toBeNull();
    expect(u.available_count).toBeNull();
  });
});

describe('toParticipant', () => {
  it('joins first + last and defaults quantity to 1', () => {
    expect(toParticipant({ firstname: 'Avery', lastname: 'Stone', myqty: 1 })).toEqual({
      display_name: 'Avery Stone',
      quantity: 1,
    });
  });

  it('carries the multi-spot quantity, comment and the release id', () => {
    const p = toParticipant({
      firstname: 'Devon',
      lastname: 'Okafor',
      myqty: 2,
      mycomment: 'Devon and partner',
      itemmemberid: 2000004,
      memberid: 1000004,
    });
    expect(p).toEqual({
      display_name: 'Devon Okafor',
      quantity: 2,
      comment: 'Devon and partner',
      item_member_id: 2000004,
      member_id: 1000004,
    });
  });

  it('falls back to nonmembername, then to a withheld placeholder', () => {
    expect(toParticipant({ nonmembername: 'Guest' }).display_name).toBe('Guest');
    expect(toParticipant({}).display_name).toBe('(name withheld)');
    expect(toParticipant({}).quantity).toBe(1);
  });

  it('ignores a zero memberid', () => {
    expect(toParticipant({ firstname: 'A', memberid: 0 }).member_id).toBeUndefined();
  });
});

describe('fetchParticipants', () => {
  it('asks for headroom above the reported count', async () => {
    const seen: string[] = [];
    const f: Fetcher = async (_u, init) => {
      seen.push((init as { body: string }).body);
      return { ok: true, status: 200, text: async () => JSON.stringify(PARTICIPANTS) };
    };
    const out = await fetchParticipants(f, 62393618, 1762735194, 5);
    expect(JSON.parse(seen[0])).toMatchObject({ listid: 62393618, slotitemid: 1762735194, offset: 1, limitTo: 55 });
    expect(out).toHaveLength(5);
    expect(out.find((p) => p.quantity === 2)?.display_name).toBe('Devon Okafor');
  });

  it('handles a negative expected count and a missing participants array', async () => {
    const f: Fetcher = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ SUCCESS: true, DATA: {}, MESSAGE: [] }),
    });
    expect(await fetchParticipants(f, 1, 2, -10)).toEqual([]);
  });

  it('handles a null DATA payload', async () => {
    const f: Fetcher = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ SUCCESS: true, DATA: null, MESSAGE: [] }),
    });
    expect(await fetchParticipants(f, 1, 2, 0)).toEqual([]);
  });
});

describe('signupgenius_list_slots tool', () => {
  function setup(fetcher?: Fetcher) {
    const server = new McpServer({ name: 't', version: '0' });
    const handlers = new Map<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
    vi.spyOn(server, 'registerTool').mockImplementation((n: string, _c: unknown, cb: unknown) => {
      handlers.set(n, cb as never);
      return undefined as never;
    });
    if (fetcher) registerSlotTools(server, fetcher);
    else registerSlotTools(server);
    return handlers.get('signupgenius_list_slots')!;
  }

  it('returns slots with participants merged in by default', async () => {
    const { fetcher, calls } = routed();
    const out = JSON.parse((await setup(fetcher)({ url: '62393618' })).content[0].text);
    expect(out.signupid).toBe(62393618);
    expect(out.slotCount).toBe(5);
    expect(out.slots[0].participants).toHaveLength(5);
    // 1 slots call + 5 participant calls.
    expect(calls).toHaveLength(6);
    expect(calls[0]).toBe('https://api.signupgenius.com/v3/signups/62393618/slots');
  });

  it('skips the participant fan-out when asked', async () => {
    const { fetcher, calls } = routed();
    const out = JSON.parse(
      (await setup(fetcher)({ url: '62393618', includeParticipants: false })).content[0].text,
    );
    expect(calls).toHaveLength(1);
    expect(out.slots[0].participants).toBeUndefined();
  });

  it('filters to available slots on request', async () => {
    const { fetcher } = routed();
    const out = JSON.parse(
      (await setup(fetcher)({ url: '62393618', onlyAvailable: true, includeParticipants: false }))
        .content[0].text,
    );
    expect(out.slots.every((s: { is_full: boolean }) => !s.is_full)).toBe(true);
    expect(out.slotCount).toBe(4);
  });

  it('sums only finite remainders and counts unlimited rows separately', async () => {
    const { fetcher } = routed({
      slots: {
        success: true,
        data: {
          slots: [
            {
              slotitems: [
                { quantity: { unlimited: true, taken: 1 } },
                { quantity: { limit: 5, taken: 2, remaining: 3 } },
              ],
            },
          ],
        },
      },
    });
    const out = JSON.parse(
      (await setup(fetcher)({ url: '1', includeParticipants: false })).content[0].text,
    );
    expect(out.totalAvailable).toBe(3);
    expect(out.unlimitedSlots).toBe(1);
  });

  it('treats a finite slot with no reported remainder as contributing zero', async () => {
    const { fetcher } = routed({
      slots: {
        success: true,
        data: { slots: [{ slotitems: [{ quantity: { limit: 4, taken: 1 } }] }] },
      },
    });
    const out = JSON.parse(
      (await setup(fetcher)({ url: '1', includeParticipants: false })).content[0].text,
    );
    expect(out.slots[0].available_count).toBeNull();
    expect(out.totalAvailable).toBe(0);
  });

  it('degrades to no participant data when that endpoint fails', async () => {
    const f: Fetcher = async (url) =>
      url.includes('/slots')
        ? { ok: true, status: 200, text: async () => JSON.stringify(SLOTS) }
        : { ok: false, status: 500, text: async () => '' };
    const out = JSON.parse((await setup(f)({ url: '62393618' })).content[0].text);
    expect(out.slotCount).toBe(5);
    expect(out.slots[0].participants).toBeUndefined();
  });

  it('reports 404, other HTTP errors, non-JSON and success:false distinctly', async () => {
    const mk = (r: Partial<{ ok: boolean; status: number; text: string }>): Fetcher =>
      async () => ({ ok: r.ok ?? true, status: r.status ?? 200, text: async () => r.text ?? '' });

    await expect(setup(mk({ ok: false, status: 404 }))({ url: '1' })).rejects.toThrow(/no sign-up with id 1/);
    await expect(setup(mk({ ok: false, status: 503 }))({ url: '1' })).rejects.toThrow(/HTTP 503/);
    await expect(setup(mk({ text: 'not json' }))({ url: '1' })).rejects.toThrow(/non-JSON body/);
    await expect(
      setup(mk({ text: JSON.stringify({ success: false, message: ['nope'] }) }))({ url: '1' }),
    ).rejects.toThrow(/nope/);
    await expect(
      setup(mk({ text: JSON.stringify({ success: false }) }))({ url: '1' }),
    ).rejects.toThrow(/unknown/);
  });

  it('caps participant lookups and says so instead of implying nobody signed up', async () => {
    // 70 rows > the 60-row cap.
    const many = {
      success: true,
      data: {
        slots: [
          {
            slotitems: Array.from({ length: 70 }, (_, i) => ({
              slotitemid: i + 1,
              quantity: { limit: 1, taken: 0, remaining: 1 },
            })),
          },
        ],
      },
    };
    const { fetcher, calls } = routed({ slots: many });
    const out = JSON.parse((await setup(fetcher)({ url: '1' })).content[0].text);
    expect(out.slotCount).toBe(70);
    // 1 slots call + exactly 60 participant calls, not 70.
    expect(calls).toHaveLength(61);
    expect(out.participantsOmitted).toMatchObject({ rows: 10 });
    expect(out.participantsOmitted.reason).toMatch(/capped at 60/);
    expect(out.slots[0].participants).toBeDefined();
    expect(out.slots[69].participants).toBeUndefined();
  });

  it('omits the cap notice when every row was covered', async () => {
    const { fetcher } = routed();
    const out = JSON.parse((await setup(fetcher)({ url: '62393618' })).content[0].text);
    expect(out.participantsOmitted).toBeUndefined();
  });

  it('defaults to the global fetch when no fetcher is injected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: { slots: [] } }),
    } as never);
    const out = JSON.parse((await setup()({ url: '5' })).content[0].text);
    expect(spy).toHaveBeenCalled();
    expect(out.slotCount).toBe(0);
  });
});
