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
//      The lift runs PER LOGIN, not once at startup: `resolveAuth()` hands the
//      client a `refresh` function and the client calls it lazily on the first
//      request and again on every detected expiry. The JWT lives 30 minutes
//      and a browser account has no password to form-login with, so a
//      once-at-boot capture left the server permanently dead after half an
//      hour. It also means a failed lift is no longer cached for the life of
//      the process — sign in, re-run the tool, and it works.
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

import { createSessionLifter } from '@fetchproxy/bootstrap';
import { classifyBridgeError, FetchproxyBridgeDownError } from '@fetchproxy/server';
import { parseBoolEnv } from '@chrischall/mcp-utils';
import { loadAccount, type Account, type SessionAccount } from './config.js';
import pkg from '../package.json' with { type: 'json' };

/** A JWT + cookie header lifted out of the signed-in browser. */
export interface BrowserSession {
  accessToken: string;
  cookieHeader: string;
}

/** Result of resolving auth, regardless of which path was taken. */
export interface ResolvedAuth {
  /**
   * Account config the client should treat as authoritative. For all three
   * paths this is an existing `Account` shape — fetchproxy synthesizes a
   * `SessionAccount` with empty credentials and lets the client skip the
   * form-login because we hand it a browser lift via `refresh`.
   */
  account: Account;
  /**
   * For the fetchproxy path: lifts a fresh JWT + cookie header out of the
   * user's signed-in browser. The client calls this INSTEAD of
   * `sessionLogin()` — once lazily on the first request, and again on every
   * detected expiry.
   *
   * This is a function, not a captured value, on purpose. The SignUpGenius
   * JWT has a 30-minute TTL (verified by decoding a live token's iat/exp), so
   * a value captured once at process start is dead within half an hour and
   * cannot be renewed — there are no credentials to re-login with in
   * fetchproxy mode. Re-reading the browser is the only renewal path.
   *
   * Undefined for env-var paths, where the client follows its normal
   * form-login flow.
   */
  refresh?: () => Promise<BrowserSession>;
  /** Which path produced this. Diagnostics only — callers should not branch. */
  source: 'env' | 'fetchproxy';
}

function fetchproxyDisabled(): boolean {
  // Fleet-standard *_DISABLE_* flag parser (placeholder/sentinel-safe).
  return parseBoolEnv('SIGNUPGENIUS_DISABLE_FETCHPROXY');
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
  //
  // NOTE: we do NOT lift the browser session here. `resolveAuth()` runs once
  // at process start; the lift is handed to the client as `refresh` and runs
  // lazily on the first request and again on every expiry. Two bugs this
  // avoids:
  //
  //   * The 30-minute cliff. The SignUpGenius JWT expires 30 minutes after
  //     issue. A startup-captured token left the server permanently
  //     unauthenticated after half an hour, with no way back — fetchproxy
  //     accounts have no credentials for a form re-login.
  //   * The sticky startup failure. A lift that failed at boot (user not yet
  //     signed in) was cached in `configError` for the life of the process, so
  //     signing in afterwards changed nothing and the advice to "retry" could
  //     never come true.
  if (!fetchproxyDisabled()) {
    return {
      account: browserAccount(),
      refresh: liftBrowserSession,
      source: 'fetchproxy',
    };
  }

  // ── Path 4: nothing configured and fetchproxy explicitly disabled.
  throw new Error(
    'Missing SignUpGenius auth config. Set SIGNUPGENIUS_USER_KEY (Pro API), ' +
      'or SIGNUPGENIUS_EMAIL + SIGNUPGENIUS_PASSWORD (session mode, free accounts), ' +
      'or install the fetchproxy extension and sign into signupgenius.com ' +
      '(unset SIGNUPGENIUS_DISABLE_FETCHPROXY if it is set).',
  );
}

/**
 * The synthetic session account used by the fetchproxy path. Credentials are
 * deliberately empty: there is no password to form-login with, so the client
 * must renew via `refresh` (the browser lift) instead.
 */
function browserAccount(): SessionAccount {
  return {
    mode: 'session',
    name: 'signupgenius.com (browser)',
    baseUrl: 'https://api.signupgenius.com/v3',
    legacyBaseUrl: 'https://www.signupgenius.com',
    loginBaseUrl: 'https://www.signupgenius.com',
    email: '',
    password: '',
  };
}

/** Where the token-refresh exchange lives. Matches config.ts's v3 default. */
const V3_BASE_URL = 'https://api.signupgenius.com/v3';

/** Renew a token with this much life left or less (seconds). */
const RENEW_SKEW_SECONDS = 120;

/**
 * Read a JWT's `exp` claim. Returns null for anything that isn't a decodable
 * JWT with a numeric `exp` — callers then treat the token as opaque and use it
 * as-is rather than guessing.
 *
 * NEVER log the decoded payload: SignUpGenius's JWT carries name, email,
 * phone, member id and IP.
 */
function jwtExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

/**
 * Exchange a stale browser token for a fresh one.
 *
 * The cookie in the browser is only as fresh as the last time the SPA renewed
 * it — an idle tab can hold a token that expired minutes ago, so simply
 * re-reading cookies is not enough to survive the 30-minute TTL. This trades
 * the `refreshToken` cookie for a new 30-minute access token via
 * `POST /v3/auth/refresh`.
 *
 * Verified against the live endpoint 2026-08-02:
 *   - Requires BOTH `refreshToken` AND `token` (the current, possibly expired
 *     access token). Sending only `refreshToken` returns 400
 *     `token should not be null or undefined`.
 *   - Responds `{success, data:{statuscode, response:{token, refreshtoken,
 *     expiresin, expires}}}` — note the lower-case inner keys — and rotates
 *     the refresh token.
 *   - Does NOT disturb the caller's existing session: a controlled test
 *     confirmed the legacy dispatcher still accepts both the old and the new
 *     token afterwards. (Renewing the JWT does not, however, revive a lapsed
 *     ColdFusion session — that is a separate lifetime, see the module docs.)
 */
async function renewIfStale(accessToken: string, refreshToken?: string): Promise<string> {
  const exp = jwtExpiry(accessToken);
  // Opaque token, or still comfortably valid → use what the browser gave us.
  if (exp === null || exp - Date.now() / 1000 > RENEW_SKEW_SECONDS) return accessToken;
  if (!refreshToken) {
    throw new Error(
      'The signupgenius.com session cookie in your browser has expired and no refreshToken ' +
        'cookie was available to renew it. Open signupgenius.com in your browser (which refreshes ' +
        'the session) and retry.',
    );
  }
  const res = await fetch(`${V3_BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refreshToken, token: accessToken }),
  });
  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; data?: { response?: { token?: string } } }
    | null;
  const renewed = body?.data?.response?.token;
  if (!res.ok || body?.success !== true || !renewed) {
    throw new Error(
      `token refresh failed (HTTP ${res.status}). The browser session may be fully expired — ` +
        'open signupgenius.com in your browser and retry.',
    );
  }
  return renewed;
}

/**
 * The declared browser scope, as a repeatable lift.
 *
 * `createSessionLifter` (bootstrap 1.9+) is the library form of what this file
 * used to hand-roll: construction touches nothing, and each call opens the
 * bridge, reads the declared buckets, and closes it. Using it also gets
 * concurrent renewals single-flighted for free — two expiries racing now share
 * one bridge round-trip instead of opening two.
 */
const liftDeclaredScope = createSessionLifter({
        serverName: pkg.name,
        version: pkg.version,
        domains: ['signupgenius.com'],
        // Read cookies at `www.signupgenius.com`, NOT the apex. The extension
        // resolves the declared domain (+ this subdomain) into the `origin` it
        // hands to `chrome.cookies.get`, and the two hosts expose different
        // sets:
        //   https://signupgenius.com      → accessToken only
        //   https://www.signupgenius.com  → accessToken + cfid + cftoken
        // The ColdFusion `cfid`/`cftoken` pair is what the legacy
        // /SUGboxAPI.cfm dispatcher authenticates against. Lifting from the
        // apex yields a JWT that looks fine but makes every legacy action
        // answer 200 `{SUCCESS:false, MESSAGE:["…You are no longer logged
        // in…"]}` — a silent, misleading failure.
        storageSubdomain: 'www',
        declare: {
          // Declare ALL the cookies we might need. The 0.3.0 read_cookies
          // capability uses chrome.cookies.get (HttpOnly-visible) — the
          // security gate is this declared key list, not HttpOnly status.
          // MTOKEN is signupgenius.com's older name for the JWT; on some
          // browsers/sessions one shows up first. accessToken takes priority
          // when both are present.
          cookies: ['MTOKEN', 'accessToken', 'cfid', 'cftoken', 'refreshToken'],
          localStorage: [],
          sessionStorage: [],
          captureHeaders: [],
        },
});

/**
 * Lift a fresh session out of the user's signed-in signupgenius.com tab.
 *
 * Runs on every login/renewal, not once at startup — fetchproxy is still NOT
 * in the request hot path, only the renewal path. The post-processing below
 * (JWT staleness check + refresh exchange) is exactly the "compose in
 * userland" shape createSessionLifter's docs describe: the library owns HOW to
 * read the browser, this owns what the values mean once read.
 */
async function liftBrowserSession(): Promise<BrowserSession> {
    try {
      const session = await liftDeclaredScope();

      const lifted = session.cookies['accessToken'] ?? session.cookies['MTOKEN'];
      const accessToken = lifted
        ? await renewIfStale(lifted, session.cookies['refreshToken'])
        : lifted;
      if (!accessToken) {
        // "retry" is honest advice now: the lift runs per login, so signing
        // in and re-running the tool genuinely picks up the new session. No
        // server restart is required (it was, before the lazy refactor).
        throw new Error(
          'accessToken cookie missing on www.signupgenius.com. ' +
            'Sign into signupgenius.com in your browser (with the fetchproxy extension installed) ' +
            'and retry.',
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

      return { accessToken, cookieHeader };
    } catch (e) {
      // Typed 0.8.0 error: SW retry already exhausted — surface `.hint` verbatim.
      if (classifyBridgeError(e) === 'bridge_down') {
        const downErr = e as FetchproxyBridgeDownError;
        throw new Error(
          `SignUpGenius auth: fetchproxy bridge is down (extension service worker unreachable after retry). ${downErr.hint}`,
        );
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        'SignUpGenius auth: no SIGNUPGENIUS_USER_KEY or SIGNUPGENIUS_EMAIL/PASSWORD set, ' +
          `and fetchproxy lift failed: ${msg}`,
      );
    }
}
