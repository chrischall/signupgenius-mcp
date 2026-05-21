// ────────────────────────────────────────────────────────────────────────────
// Auth resolution — Pattern A template
// ────────────────────────────────────────────────────────────────────────────
//
// SignUpGenius supports three auth paths. This file picks one, in priority
// order, and hands the chosen path to `SignUpGeniusClient`. It mirrors the
// Pattern A shape used by ofw-mcp/src/auth.ts so all sibling MCPs in this
// family stay structurally aligned.
//
// THE THREE PATHS, in priority order:
//
//   1. Pro API key (existing)
//      SIGNUPGENIUS_USER_KEY set → stateless `Authorization: <key>` against
//      the documented v2/k Pro API. The only path that can call slot reports.
//      Unchanged from pre-fetchproxy behavior.
//
//   2. Session-login (existing)
//      SIGNUPGENIUS_EMAIL + SIGNUPGENIUS_PASSWORD set → POST the login form,
//      scrape `csrfToken`, capture `accessToken` (JWT) + `cfid`/`cftoken`
//      cookies. Calls go to the v3 web API (Bearer) and the legacy
//      `/SUGboxAPI.cfm` dispatcher (cookies). Unchanged from pre-fetchproxy
//      behavior.
//
//   3. fetchproxy fallback (new)
//      When no env vars are set, lift the user's session out of their
//      already-signed-in signupgenius.com browser tab. `@fetchproxy/bootstrap`
//      opens a one-shot WebSocket bridge, asks the extension for the
//      `accessToken` / `MTOKEN` / `cfid` / `cftoken` cookies (all declared
//      upfront — that's the security boundary), and closes the bridge.
//      Subsequent SignUpGenius calls go out via plain Node `fetch()` with
//      those cookies attached — fetchproxy is NOT in the request hot path.
//
//      Note: `accessToken` and `MTOKEN` carry the same JWT value (verified
//      via DevTools); we accept either and prefer `accessToken` if both are
//      present.
//
//      Users opt out with SIGNUPGENIUS_DISABLE_FETCHPROXY=1 (anyone who
//      wants the old behavior of "fail loudly when creds are missing").
//
//   4. Error
//      Nothing to authenticate with. We throw a message that names both
//      escape hatches: set creds OR install the extension and sign in.
//
// Testability:
//   - `@fetchproxy/bootstrap` is mocked at the module boundary in tests.
//   - `loadAccount()` (the existing env-var resolver) is reused as-is so the
//     legacy paths keep working unchanged.

import { bootstrap } from '@fetchproxy/bootstrap';
import { loadAccount, type Account, type SessionAccount } from './config.js';
import pkg from '../package.json' with { type: 'json' };

/** Result of resolving auth, regardless of which path was taken. */
export interface ResolvedAuth {
  /**
   * Account config the client should treat as authoritative. For all three
   * paths this is an existing `Account` shape — fetchproxy synthesizes a
   * `SessionAccount` with empty credentials and lets the client skip the
   * form-login because we hand it pre-loaded cookies via `preloaded`.
   */
  account: Account;
  /**
   * For the fetchproxy path: the JWT + cookie header we pulled from the
   * browser. The client uses these in place of running `sessionLogin()`.
   * For env-var paths this is undefined and the client follows its normal
   * lazy-login flow.
   */
  preloaded?: {
    accessToken: string;
    cookieHeader: string;
  };
  /** Which path produced this. Diagnostics only — callers should not branch. */
  source: 'env' | 'fetchproxy';
}

function readEnv(key: string): string | undefined {
  const raw = process.env[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === 'undefined' || trimmed === 'null') return undefined;
  if (/^\$\{[^}]*\}$/.test(trimmed)) return undefined;
  return trimmed;
}

function fetchproxyDisabled(): boolean {
  const raw = readEnv('SIGNUPGENIUS_DISABLE_FETCHPROXY');
  if (raw === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/**
 * The exact error message `loadAccount()` throws when NO auth env vars are
 * set. We catch this specific string so partial-config errors (which the
 * user MUST fix) still propagate, but the "you didn't set anything at all"
 * case falls through to fetchproxy.
 */
const NO_ENV_CONFIG_MARKER = 'Missing SignUpGenius auth config';

/**
 * Resolve SignUpGenius auth using the three-path priority described at the
 * top of this file. Throws with an actionable message when no path succeeds.
 */
export async function resolveAuth(): Promise<ResolvedAuth> {
  // ── Paths 1 & 2: env-var credentials. loadAccount() handles precedence,
  //    partial-config errors, and env-var sanitization for us.
  try {
    const account = loadAccount();
    return { account, source: 'env' };
  } catch (e) {
    // `loadAccount()` only ever throws plain Error instances (validated by
    // tests in config.test.ts). Partial-config errors (missing one of the
    // EMAIL/PASSWORD pair, non-https override URL, etc.) are USER MISTAKES
    // and should propagate. Only the "nothing set at all" case is allowed
    // to fall through to fetchproxy.
    if (!(e as Error).message.startsWith(NO_ENV_CONFIG_MARKER)) {
      throw e;
    }
  }

  // ── Path 3: fetchproxy fallback.
  if (!fetchproxyDisabled()) {
    try {
      const session = await bootstrap({
        serverName: pkg.name,
        version: pkg.version,
        domains: ['signupgenius.com'],
        declare: {
          // Declare ALL the cookies we might need. The 0.3.0 read_cookies
          // capability uses chrome.cookies.get (HttpOnly-visible) — the
          // security gate is this declared key list, not HttpOnly status.
          // MTOKEN is signupgenius.com's older name for the JWT; on some
          // browsers/sessions one shows up first. accessToken takes priority
          // when both are present.
          cookies: ['MTOKEN', 'accessToken', 'cfid', 'cftoken'],
          localStorage: [],
          sessionStorage: [],
          captureHeaders: [],
        },
      });

      const accessToken =
        session.cookies['accessToken'] ?? session.cookies['MTOKEN'];
      if (!accessToken) {
        throw new Error(
          'accessToken cookie missing on signupgenius.com. ' +
            'Sign into signupgenius.com in your browser (with the fetchproxy extension installed) and retry.',
        );
      }

      // Build the cookie header the legacy /SUGboxAPI.cfm dispatcher expects.
      // accessToken first (the JWT also lives in this cookie jar) then the CF
      // pair if present. Anything else gets ignored.
      const parts: string[] = [`accessToken=${accessToken}`];
      const cfid = session.cookies['cfid'];
      const cftoken = session.cookies['cftoken'];
      if (cfid) parts.push(`cfid=${cfid}`);
      if (cftoken) parts.push(`cftoken=${cftoken}`);
      const cookieHeader = parts.join('; ');

      // Synthesize a session account with empty creds — the client will see
      // `preloaded` and skip the form login. The bases match the defaults
      // used by `loadAccount()` so behavior is identical from here on.
      const account: SessionAccount = {
        mode: 'session',
        name: 'signupgenius.com (browser)',
        baseUrl: 'https://api.signupgenius.com/v3',
        legacyBaseUrl: 'https://www.signupgenius.com',
        loginBaseUrl: 'https://www.signupgenius.com',
        email: '',
        password: '',
      };

      return {
        account,
        preloaded: { accessToken, cookieHeader },
        source: 'fetchproxy',
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        'SignUpGenius auth: no SIGNUPGENIUS_USER_KEY or SIGNUPGENIUS_EMAIL/PASSWORD set, ' +
          `and fetchproxy fallback failed: ${msg}`,
      );
    }
  }

  // ── Path 4: nothing configured and fetchproxy explicitly disabled.
  throw new Error(
    'Missing SignUpGenius auth config. Set SIGNUPGENIUS_USER_KEY (Pro API), ' +
      'or SIGNUPGENIUS_EMAIL + SIGNUPGENIUS_PASSWORD (session mode, free accounts), ' +
      'or install the fetchproxy extension and sign into signupgenius.com ' +
      '(unset SIGNUPGENIUS_DISABLE_FETCHPROXY if it is set).',
  );
}
