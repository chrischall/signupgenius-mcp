import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sessionCachePath,
  createSessionCache,
  reportCacheWriteFailure,
} from '../src/session-cache.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sug-cache-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A full env with credentials and the cache enabled. */
const withCreds = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  SIGNUPGENIUS_EMAIL: 'user@example.com',
  SIGNUPGENIUS_PASSWORD: 'pw1',
  SIGNUPGENIUS_SESSION_CACHE: 'true',
  ...over,
});

/** The stored envelope: a cookie session plus the time it was minted. */
const record = (over: Partial<{ accessToken: string; cookieHeader: string }> = {}) => ({
  session: { accessToken: 'JWT', cookieHeader: 'sid=abc', ...over },
  sessionAt: Date.now(),
});

const cacheFile = (d: string): string => join(d, '.signupgenius-mcp', 'session.json');

describe('sessionCachePath', () => {
  it('prefers MCP_DATA_DIR, the variable mcp-host injects', () => {
    expect(sessionCachePath({ MCP_DATA_DIR: '/data' })).toBe(
      '/data/.signupgenius-mcp/session.json',
    );
  });

  it('honours an explicit SIGNUPGENIUS_SESSION_FILE', () => {
    expect(
      sessionCachePath({ SIGNUPGENIUS_SESSION_FILE: '/tmp/x.json', MCP_DATA_DIR: '/data' }),
    ).toBe('/tmp/x.json');
  });

  it('ignores a sentinel or placeholder override', () => {
    // A relative "./null" would park the session under the process cwd.
    expect(sessionCachePath({ SIGNUPGENIUS_SESSION_FILE: 'null', HOME: '/home/u' })).toBe(
      '/home/u/.signupgenius-mcp/session.json',
    );
  });
});

describe('createSessionCache', () => {
  it('round-trips a session through a 0600 file', () => {
    const env = withCreds({ MCP_DATA_DIR: dir });
    const p = createSessionCache({ env })!;
    expect(p).not.toBeNull();
    p.save(record());
    expect(statSync(cacheFile(dir)).mode & 0o777).toBe(0o600);
    expect(createSessionCache({ env })!.load()).toEqual(
      expect.objectContaining({ session: { accessToken: 'JWT', cookieHeader: 'sid=abc' } }),
    );
  });

  it('discards the cache when the password is rotated', () => {
    const env = withCreds({ MCP_DATA_DIR: dir });
    createSessionCache({ env })!.save(record());
    const rotated = createSessionCache({
      env: withCreds({ MCP_DATA_DIR: dir, SIGNUPGENIUS_PASSWORD: 'pw2' }),
    })!;
    expect(rotated.load()).toBeNull();
  });

  it('discards the cache when the account changes', () => {
    const env = withCreds({ MCP_DATA_DIR: dir });
    createSessionCache({ env })!.save(record());
    const other = createSessionCache({
      env: withCreds({ MCP_DATA_DIR: dir, SIGNUPGENIUS_EMAIL: 'someone@else.com' }),
    })!;
    expect(other.load()).toBeNull();
  });

  it('matches the email case-insensitively', () => {
    const env = withCreds({ MCP_DATA_DIR: dir });
    createSessionCache({ env })!.save(record());
    const cased = createSessionCache({
      env: withCreds({ MCP_DATA_DIR: dir, SIGNUPGENIUS_EMAIL: '  User@Example.COM ' }),
    })!;
    expect(cased.load()).not.toBeNull();
  });

  it('writes neither the email, the password, nor a plaintext credential', () => {
    const env = withCreds({ MCP_DATA_DIR: dir });
    createSessionCache({ env })!.save(record());
    const body = readFileSync(cacheFile(dir), 'utf8');
    expect(body).not.toContain('pw1');
    expect(body).not.toContain('user@example.com');
  });

  it.each([
    ['null', null],
    ['a primitive', 'nope'],
    ['a missing sessionAt', { session: { accessToken: 'J', cookieHeader: 'c' } }],
    ['a primitive session', { session: 'nope', sessionAt: 1 }],
    ['a missing accessToken', { session: { cookieHeader: 'c' }, sessionAt: 1 }],
    ['an empty accessToken', { session: { accessToken: '', cookieHeader: 'c' }, sessionAt: 1 }],
    ['a missing cookieHeader', { session: { accessToken: 'J' }, sessionAt: 1 }],
    ['an empty cookieHeader', { session: { accessToken: 'J', cookieHeader: '' }, sessionAt: 1 }],
  ])('rejects %s rather than handing it to the session manager', (_label, body) => {
    const env = withCreds({ MCP_DATA_DIR: dir });
    const p = createSessionCache({ env })!;
    p.save(record());
    // Swap only the STATE, keeping the envelope's salted binding intact —
    // overwriting the whole file would be rejected by the binding check before
    // the shape guard ever ran, which is the wrong reason to pass this test.
    const envelope = JSON.parse(readFileSync(cacheFile(dir), 'utf8')) as { state: unknown };
    envelope.state = body;
    writeFileSync(cacheFile(dir), JSON.stringify(envelope), { mode: 0o600 });
    expect(createSessionCache({ env })!.load()).toBeNull();
  });

  it.each([
    ['the fetchproxy path', { browserBacked: true }, withCreds({ MCP_DATA_DIR: '/x' })],
    [
      'SIGNUPGENIUS_SESSION_CACHE=false',
      {},
      withCreds({ MCP_DATA_DIR: '/x', SIGNUPGENIUS_SESSION_CACHE: 'false' }),
    ],
    ['key mode with no email', {}, { SIGNUPGENIUS_PASSWORD: 'pw', MCP_DATA_DIR: '/x' }],
    ['key mode with no password', {}, { SIGNUPGENIUS_EMAIL: 'u', MCP_DATA_DIR: '/x' }],
  ])('is disabled for %s', (_label, opts, env) => {
    expect(createSessionCache({ ...opts, env })).toBeNull();
  });

  it('writes nothing at all when disabled', () => {
    const env = withCreds({ MCP_DATA_DIR: dir, SIGNUPGENIUS_SESSION_CACHE: 'false' });
    expect(createSessionCache({ env })).toBeNull();
    expect(existsSync(join(dir, '.signupgenius-mcp'))).toBe(false);
  });
});

describe('reportCacheWriteFailure', () => {
  it.each([
    ['an Error', new Error('EROFS'), 'EROFS'],
    ['a non-Error', 'disk gone', 'disk gone'],
  ])('names the cause for %s and stays on stderr', (_label, thrown, expected) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      reportCacheWriteFailure(thrown);
      expect(err).toHaveBeenCalledWith(expect.stringContaining(expected as string));
      // stdout is the JSON-RPC channel; a stray write there corrupts the stream.
      expect(out).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });
});
