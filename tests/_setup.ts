// Suite-wide guard: no test may touch the developer's real session cache.
//
// `createSessionCache` resolves its path from MCP_DATA_DIR/HOME, so any test
// with SIGNUPGENIUS_EMAIL + SIGNUPGENIUS_PASSWORD set would read and write
// ~/.signupgenius-mcp/session.json — non-hermetic, order-dependent, and able to
// leave a real file behind. The equivalent adoption in ofw-mcp did exactly that
// before this guard existed there.
//
// Two independent guards, deliberately belt-and-braces:
//   1. The cache is OFF by default, so the ordinary suite never constructs one.
//   2. The path is pinned into a temp dir anyway, so a test that turns the cache
//      ON to exercise it still cannot reach $HOME.
import { beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const CACHE_DIR = mkdtempSync(join(tmpdir(), 'sug-test-cache-'));

beforeEach(() => {
  process.env.SIGNUPGENIUS_SESSION_CACHE = 'false';
  process.env.SIGNUPGENIUS_SESSION_FILE = join(CACHE_DIR, 'session.json');
});

afterAll(() => {
  rmSync(CACHE_DIR, { recursive: true, force: true });

  // The tripwire, and why the guards above are not enough on their own: both
  // work through process.env, and a client that reads an INJECTED env bypasses
  // them completely — the path resolver then falls back to os.homedir(), which
  // no environment variable can redirect. Fixing exactly that plumbing in
  // schoolpass-mcp is what created a real file under $HOME.
  //
  // So assert the outcome rather than the mechanism.
  const leaked = join(homedir(), '.signupgenius-mcp');
  if (existsSync(leaked)) {
    throw new Error(
      `A test wrote to ${leaked}. The suite must never touch the real home ` +
        'directory — inject SIGNUPGENIUS_SESSION_CACHE=false (or a temp SIGNUPGENIUS_SESSION_FILE) ' +
        'into the env that test hands the client.',
    );
  }
});
