import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
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

interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

/**
 * Reads the REGISTERED config rather than a hand-kept list. Session mode is
 * the superset: rsvp, claim/release and the legacy listing register only
 * there, so it is the mode that covers every tool the server can serve.
 *
 * `destructiveHint` DEFAULTS TO TRUE whenever readOnlyHint is false, so a
 * write that forgets to declare it publishes as destructive and nothing
 * fails — a considered `false` and a forgotten one look identical. Each
 * write has to CHOOSE.
 */
function registeredAnnotations(): Record<string, Ann | undefined> {
  const seen: Record<string, Ann | undefined> = {};
  const client = new SignUpGeniusClient(sessionAccount);
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, cfg: unknown) => {
    seen[name] = (cfg as { annotations?: Ann }).annotations;
    return undefined as never;
  });
  registerUserTools(server, client);
  registerHealthcheckTools(server, client);
  registerGroupTools(server, client);
  registerSignUpTools(server, client);
  registerReportTools(server, client);
  registerPublicSignUpTool(server);
  registerSlotTools(server);
  registerRsvpTool(server, client);
  registerSlotWriteTools(server, client);
  return seen;
}

describe('every tool is annotated truthfully', () => {
  it('registers the full surface (guards against a registrar being dropped here)', () => {
    expect(Object.keys(registeredAnnotations())).toHaveLength(20);
  });

  it('sets an explicit boolean readOnlyHint on all of them', () => {
    const missing = Object.entries(registeredAnnotations())
      .filter(([, a]) => typeof a?.readOnlyHint !== 'boolean')
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', () => {
    const undeclared = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([name]) => name);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', () => {
    const contradictory = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([name]) => name);
    expect(contradictory).toEqual([]);
  });

  it('marks every tool open-world (each one calls signupgenius.com)', () => {
    const notOpen = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.openWorldHint !== true)
      .map(([name]) => name);
    expect(notOpen).toEqual([]);
  });

  it('marks every write destructive — each reaches another person or has no inverse here', () => {
    // add_group_member puts a third party on the group's invitation list and
    // nothing here removes a member; rsvp and claim_slot write data the
    // organizer sees (and rsvp cannot be changed or withdrawn from here);
    // release_slot removes a real sign-up.
    const destructive = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && a?.destructiveHint === true)
      .map(([name]) => name)
      .sort();
    expect(destructive).toEqual([
      'signupgenius_add_group_member',
      'signupgenius_claim_slot',
      'signupgenius_release_slot',
      'signupgenius_rsvp',
    ]);
  });
});
