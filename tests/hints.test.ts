import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { SignUpGeniusClient } from '../src/client.js';
import { registerUserTools } from '../src/tools/user.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerGroupTools } from '../src/tools/groups.js';
import { registerSignUpTools } from '../src/tools/signups.js';
import { registerReportTools } from '../src/tools/reports.js';
import { registerPublicSignUpTool } from '../src/tools/public-signup.js';
import { registerSlotTools } from '../src/tools/slots.js';
import { registerRsvpTool } from '../src/tools/rsvp.js';
import { registerSlotWriteTools } from '../src/tools/slot-write.js';
import { sessionAccount } from './tools/_setup.js';

/**
 * Context-group hints (`_meta.mint`, mcp-host spec 2026-11-03 D4), read off the
 * config each registrar hands `registerTool` — where the hints are authored —
 * and, separately, off `tools/list`, which is what a host sees. Session mode is
 * the superset (rsvp, claim/release and the legacy listing register only there).
 */
type Register = (server: McpServer, client: SignUpGeniusClient) => void;
const REGISTRARS: Register[] = [
  registerUserTools,
  registerGroupTools,
  registerSignUpTools,
  registerReportTools,
  (server) => registerPublicSignUpTool(server),
  (server) => registerSlotTools(server),
  registerRsvpTool,
  registerSlotWriteTools,
];

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

interface Config {
  _meta?: Record<string, unknown>;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

function registeredConfigs(): Map<string, Config> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const configs = new Map<string, Config>();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown) => {
    configs.set(name, config as Config);
    return undefined as never;
  });
  const client = new SignUpGeniusClient(sessionAccount);
  for (const register of REGISTRARS) register(server, client);
  return configs;
}

const mintOf = (c: Config | undefined) => c?._meta?.mint as Record<string, unknown> | undefined;
const shapeOf = (c: Config) =>
  ((c.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {}) as Record<string, unknown>;

afterEach(() => vi.restoreAllMocks());

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  signupgenius_get_profile: 'lookup',
  signupgenius_list_groups: 'lookup',
  signupgenius_list_group_members: 'lookup',
  signupgenius_get_group_member: 'lookup',
  signupgenius_add_group_member: 'change',
  signupgenius_list_created_active: 'lookup',
  signupgenius_list_created_expired: 'lookup',
  signupgenius_list_created_all: 'lookup',
  signupgenius_list_invited: 'whats-new',
  signupgenius_list_signedupfor: 'whats-on',
  signupgenius_legacy_get_my_signups: 'lookup',
  signupgenius_report_all: 'lookup',
  signupgenius_report_filled: 'lookup',
  signupgenius_report_available: 'lookup',
  signupgenius_get_public_signup: 'lookup',
  signupgenius_list_slots: 'lookup',
  signupgenius_rsvp: 'send',
  signupgenius_claim_slot: 'change',
  signupgenius_release_slot: 'change',
};

describe('_meta.mint on every registered tool', () => {
  it('names every tool registerTool was handed, so a new tool cannot skip the decision', () => {
    expect([...registeredConfigs().keys()].sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s declares domain school and intent %s', (name, intent) => {
    const mint = mintOf(registeredConfigs().get(name));
    expect(mint).toBeDefined();
    expect(mint!.domain).toBe('school');
    expect(mint!.intent).toBe(intent);
  });

  it('every hint is shaped per the host contract', () => {
    for (const [name, config] of registeredConfigs()) {
      const mint = mintOf(config)!;
      expect(Object.keys(mint).filter((k) => !KEYS.includes(k)), name).toEqual([]);
      expect(DOMAINS, name).toContain(mint.domain);
      expect(INTENTS, name).toContain(mint.intent);
      if ('canonical' in mint) {
        expect(mint.canonical, name).toBe(true);
        expect(config.annotations?.readOnlyHint, name).toBe(true);
        expect(CANONICAL_INTENTS, name).toContain(mint.intent);
      }
      if ('subject' in mint) expect(shapeOf(config), name).toHaveProperty(mint.subject as string);
      if ('when' in mint) {
        const when = mint.when as Record<string, unknown>;
        expect(Object.keys(when).sort(), name).toEqual(['end', 'start']);
        expect(shapeOf(config), name).toHaveProperty(when.start as string);
        expect(shapeOf(config), name).toHaveProperty(when.end as string);
      }
      if ('aliases' in mint) {
        const aliases = mint.aliases as string[];
        expect(aliases.length, name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, name).toBeLessThanOrEqual(40);
          expect(a, name).toBe(a.toLowerCase());
        }
      }
    }
  });

  it('at most one canonical read per intent: invitations for whats-new, my sign-ups for whats-on', () => {
    const canonical = [...registeredConfigs()]
      .filter(([, c]) => mintOf(c)!.canonical === true)
      .map(([n, c]) => [n, mintOf(c)!.intent]);
    expect(canonical.sort()).toEqual([
      ['signupgenius_list_invited', 'whats-new'],
      ['signupgenius_list_signedupfor', 'whats-on'],
    ]);
  });

  it('a canonical read takes view: brief, and names no subject or range (SignUpGenius has neither)', () => {
    const configs = registeredConfigs();
    for (const name of ['signupgenius_list_invited', 'signupgenius_list_signedupfor']) {
      const config = configs.get(name)!;
      expect(shapeOf(config), name).toHaveProperty('view');
      const mint = mintOf(config)!;
      expect(mint, name).not.toHaveProperty('subject');
      expect(mint, name).not.toHaveProperty('when');
    }
  });

  it('the canonical reads carry the words a person says', () => {
    const configs = registeredConfigs();
    expect(mintOf(configs.get('signupgenius_list_signedupfor'))?.aliases).toEqual(
      expect.arrayContaining(['signed up', 'volunteering']),
    );
    expect(mintOf(configs.get('signupgenius_list_invited'))?.aliases).toEqual(
      expect.arrayContaining(['invitations']),
    );
  });
});

describe('_meta.mint on tools/list', () => {
  it('reaches the wire for every tool except the healthcheck', async () => {
    const client = new SignUpGeniusClient(sessionAccount);
    const h = await createTestHarness((server) => {
      registerHealthcheckTools(server, client);
      for (const register of REGISTRARS) register(server, client);
    });
    const { tools } = await h.client.listTools();
    await h.close?.();
    const unhinted = tools
      .filter((t) => !(t._meta as Record<string, unknown> | undefined)?.mint)
      .map((t) => t.name);
    // The healthcheck joins no group: a tool with no hint is in the host's
    // `all` connector only (spec D4).
    expect(unhinted).toEqual(['signupgenius_healthcheck']);
    expect(tools).toHaveLength(Object.keys(EXPECTED_INTENT).length + 1);
    const mine = tools.find((t) => t.name === 'signupgenius_list_signedupfor');
    expect((mine?._meta as Record<string, unknown>).mint).toMatchObject({ canonical: true, intent: 'whats-on' });
  });
});
