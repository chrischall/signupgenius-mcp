import { McpToolError, ModeMismatchError, UnreachableError } from '@chrischall/mcp-utils';
import { CookieSessionManager } from '@chrischall/mcp-utils/session';
import type { Account } from './config.js';

// Re-exported so tools/tests keep importing the error types from the client
// module (the shared classes live in @chrischall/mcp-utils since 0.10.x).
export { ModeMismatchError, UnreachableError };
import { sessionLogin as defaultSessionLogin } from './auth-session-login.js';

export type SessionLoginFn = typeof defaultSessionLogin;

/** The cookie session shape this MCP threads through `CookieSessionManager`. */
interface SugSession {
  accessToken: string;
  cookieHeader: string;
}

export interface RequestOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * Session mode only: route via the legacy `/SUGboxAPI.cfm?go=<action>`
   * dispatcher instead of the v3 JSON API. Pass the `go=` action (e.g.
   * `t.getMySignups`). Ignored in key mode.
   */
  legacyAction?: string;
}

/** Normalized envelope returned by every code path. Tools see this shape. */
export interface ApiResponse<T> {
  data: T;
  message: string[];
  success: boolean;
}

/** Raw upper-case envelope from `/SUGboxAPI.cfm` — converted to ApiResponse on the way out. */
interface LegacyEnvelope<T> {
  DATA: T;
  MESSAGE: string[] | string;
  SUCCESS: boolean;
}

/**
 * Detect a session that lapsed server-side. SignUpGenius signals expiry two
 * different ways, both of which must trigger a re-login:
 *
 *  1. A `401` on the v3 JSON API / legacy SUGboxAPI dispatcher — the JWT/cookies
 *     are stale. (403 is a Pro-permission failure, not expiry — left alone.)
 *  2. A `200` that renders the legacy HTML **login page** instead of JSON — the
 *     ColdFusion session lapsed and the server quietly bounced us to the form.
 *     Scoped to the login page (its `loginform`/`loginemail`/`go=c.Login`
 *     markers) so an unrelated non-JSON 200 still surfaces as a parse error
 *     rather than masquerading as an expiry.
 *
 *  3. A `200` with a well-formed **JSON** envelope whose `SUCCESS` is false and
 *     whose `MESSAGE` says "You are no longer logged in". The legacy
 *     /SUGboxAPI.cfm dispatcher answers this way when the ColdFusion
 *     `cfid`/`cftoken` pair is missing or stale — the JWT alone does not
 *     satisfy it. Without this case an expired legacy session surfaced as a
 *     generic application error and never triggered the re-login it needed.
 *     Deliberately narrow: any OTHER `SUCCESS:false` is a real application
 *     error and must surface untouched, or a genuine failure would burn a
 *     pointless re-login and hide itself behind the retry.
 *
 * Reads a clone so the caller can still consume the original body.
 */
const LEGACY_LOGGED_OUT = /you are no longer logged in/i;

async function isSessionExpired(res: Response): Promise<boolean> {
  if (res.status === 401) return true;
  if (res.status !== 200) return false;
  const text = await res.clone().text();
  // Shape 3 is checked WITHOUT consulting content-type. The dispatcher's
  // header is not a dependable discriminator, and the phrase is specific
  // enough that a false positive is not a practical concern.
  if (LEGACY_LOGGED_OUT.test(text)) return true;
  // Shape 2 stays gated to non-JSON responses, as before: the login-page
  // markers are short enough that scanning JSON bodies for them could
  // plausibly misfire on user-authored sign-up content.
  const ct = res.headers.get('content-type') ?? '';
  if (ct && !ct.includes('text/html')) return false;
  return /loginform|loginemail|go=c\.Login/i.test(text);
}

export class SignUpGeniusClient {
  private account: Account | null;
  private configError: Error | null;
  private sessionLoginFn: SessionLoginFn;
  /** Present only in session/fetchproxy mode; owns login + expiry-replay. */
  private session: CookieSessionManager<SugSession> | null = null;

  /**
   * Accepts either a fully-resolved Account or a deferred error from
   * loadAccount. When `account` is null and `configError` is set, every
   * tool call surfaces the error — but the server still starts cleanly,
   * which is what the install-time smoke test requires.
   *
   * `refreshSession` is the fetchproxy escape hatch: when set, it REPLACES
   * `sessionLogin()` as the way this client mints a session — called lazily on
   * the first request and again on every detected expiry. It must re-read the
   * browser each time rather than return a captured value; the SignUpGenius
   * JWT lives 30 minutes, and a fetchproxy account has no credentials to
   * form-login with once it lapses.
   */
  constructor(
    account: Account | null,
    opts: {
      configError?: Error;
      sessionLogin?: SessionLoginFn;
      refreshSession?: () => Promise<SugSession>;
    } = {},
  ) {
    this.account = account;
    this.configError = opts.configError ?? null;
    this.sessionLoginFn = opts.sessionLogin ?? defaultSessionLogin;
    if (account?.mode === 'session') {
      this.session = this.makeSessionManager(account, opts.refreshSession);
    }
  }

  /**
   * Build the cookie-session manager for session/fetchproxy mode.
   *
   * `login` mints a fresh session, and `CookieSessionManager` calls it lazily
   * on the first request and once more on a detected expiry (then replays).
   * Three cases:
   *
   *   * `refreshSession` set (fetchproxy) — re-lift the browser session. This
   *     runs on EVERY renewal, not just the first, which is what keeps the
   *     path alive past the JWT's 30-minute TTL.
   *   * credentials present (plain session mode) — run `sessionLogin()`.
   *   * neither — nothing can mint a session; throwing here makes
   *     `withSession` surface the original response rather than loop on a
   *     doomed re-login.
   */
  private makeSessionManager(
    acct: Extract<Account, { mode: 'session' }>,
    refreshSession?: () => Promise<SugSession>,
  ): CookieSessionManager<SugSession> {
    return new CookieSessionManager<SugSession>({
      login: async () => {
        if (refreshSession) return refreshSession();
        if (!acct.email || !acct.password) {
          throw new AuthError(401);
        }
        const result = await this.sessionLoginFn({
          loginUrl: acct.loginBaseUrl,
          email: acct.email,
          password: acct.password,
        });
        return { accessToken: result.accessToken, cookieHeader: result.cookieHeader };
      },
      isExpired: isSessionExpired,
    });
  }

  describe(): { name: string; mode: Account['mode']; baseUrl: string } | { error: string } {
    if (!this.account) return { error: this.configError?.message ?? 'no account configured' };
    return { name: this.account.name, mode: this.account.mode, baseUrl: this.account.baseUrl };
  }

  private requireAccount(): Account {
    if (this.account) return this.account;
    throw this.configError ?? new Error('SignUpGenius client is not configured');
  }

  /**
   * Account mode shorthand for tool *registration* logic. Returns the
   * configured mode if available, otherwise defaults to 'session' so the
   * recommended set of tools is registered when the host smoke-tests an
   * install that hasn't been configured yet. The actual config error is
   * raised when a tool is invoked.
   */
  get mode(): Account['mode'] {
    return this.account?.mode ?? 'session';
  }

  async request<T>(path: string, opts: RequestOpts = {}): Promise<ApiResponse<T>> {
    const acct = this.requireAccount();
    if (acct.mode === 'session' && opts.legacyAction) {
      return this.requestLegacy<T>(opts.legacyAction, opts);
    }
    return this.requestApi<T>(path, opts);
  }

  /** Throws if the current mode can't satisfy the call — e.g. Pro-only reports. */
  requireMode(mode: Account['mode'], featureLabel: string): void {
    const acct = this.requireAccount();
    if (acct.mode !== mode) {
      throw new ModeMismatchError(acct.mode, mode, featureLabel);
    }
  }

  /**
   * Guard for features ONLY key mode can ever satisfy (the Pro slot reports).
   *
   * Why this exists instead of just calling `requireMode('key', …)`:
   * `requireMode` calls `requireAccount()` first, so when config resolution was
   * deferred the stored `configError` is what surfaces — and that error's
   * remediation ("sign into signupgenius.com in your browser") can never
   * enable a key-only feature. The user then chases a browser sign-in that
   * cannot possibly fix the tool. Check the mode first so the requirement that
   * actually applies leads, while keeping the config error visible in case it
   * is itself a key-mode misconfiguration (e.g. a bad SIGNUPGENIUS_BASE_URL
   * alongside a valid SIGNUPGENIUS_USER_KEY).
   */
  requireKeyMode(featureLabel: string): void {
    if (this.account) {
      this.requireMode('key', featureLabel);
      return;
    }
    throw new KeyModeRequiredError(featureLabel, this.configError);
  }

  /**
   * Walk the browser-side "click RSVP NOW" preprocess step. Without this
   * call, follow-up SUGboxAPI actions (`s.getSignupInfo`,
   * `s.processSignUpFormHandler`, …) return "Oops! Looks like there's none to
   * be processed" — the server keeps the active-signup pointer in ColdFusion
   * session state and PreProcessSignup is what sets it.
   *
   * Session mode only. The endpoint is a form-encoded POST to
   * `/index.cfm?go=s.PreProcessSignup&URLID=<urlid>` that 301s to
   * `s.ProcessSignup`; we don't care about the redirect target itself, only
   * that the server accepted the URL.
   */
  async preProcessSignUp(urlid: string): Promise<void> {
    this.requireMode('session', 'preProcessSignUp');
    const acct = this.requireAccount() as Extract<Account, { mode: 'session' }>;
    const url = `${acct.legacyBaseUrl}/index.cfm?go=s.PreProcessSignup&URLID=${encodeURIComponent(urlid)}`;
    const res = await this.session!.withSession((session) =>
      fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          ...sessionAuthHeaders(session),
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html',
        },
        body: 'ScreenWidth=2000&ScreenHeight=1200',
      }),
    );
    // The browser sees a 301 → /index.cfm?go=s.ProcessSignup. A 200 means the
    // server rendered an error page instead; a 4xx/5xx means the JWT/cookies
    // are stale. Treat anything other than the documented redirect codes as
    // an explicit failure rather than silently moving on.
    if (res.status !== 301 && res.status !== 302) {
      throw new Error(
        `PreProcessSignup for ${urlid} returned status ${res.status} ` +
          `(expected 301/302). The sign-up may be locked, expired, or invitee-only.`,
      );
    }
  }

  private async requestApi<T>(path: string, opts: RequestOpts): Promise<ApiResponse<T>> {
    const acct = this.requireAccount();
    const normalizedPath = path.endsWith('/') ? path : `${path}/`;
    const params = new URLSearchParams();
    if (acct.mode === 'key') params.set('user_key', acct.userKey);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    const url = `${acct.baseUrl}${normalizedPath}${qs ? `?${qs}` : ''}`;

    const res = await this.authedFetch(url, {
      method: opts.method ?? 'GET',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    });
    return parseEnvelope<T>(res, path, normalizeKeyShape as Normalizer<T>);
  }

  private async requestLegacy<T>(action: string, opts: RequestOpts): Promise<ApiResponse<T>> {
    // request() only routes here when mode === 'session', so the cast is safe.
    const acct = this.requireAccount() as Extract<Account, { mode: 'session' }>;
    const url = `${acct.legacyBaseUrl}/SUGboxAPI.cfm?go=${encodeURIComponent(action)}`;
    const res = await this.authedFetch(url, {
      method: 'POST',
      body: JSON.stringify(opts.body ?? {}),
      headers: { 'Content-Type': 'application/json' },
    });
    return parseEnvelope<T>(res, action, normalizeLegacyShape as Normalizer<T>);
  }

  /**
   * Fetch with auth attached. Key mode is stateless. Session/fetchproxy mode
   * routes through the `CookieSessionManager`, which logs in lazily on the
   * first call and — on a detected expiry (401 or a 200 legacy-HTML login
   * page, see {@link isSessionExpired}) — re-mints credentials and replays the
   * request exactly once.
   */
  private async authedFetch(
    url: string,
    init: { method: string; body?: BodyInit; headers?: Record<string, string> },
  ): Promise<Response> {
    if (!this.session) {
      // key mode: stateless, user_key rides in the query string.
      return fetch(url, {
        method: init.method,
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        body: init.body,
      });
    }
    return this.session.withSession((session) =>
      fetch(url, {
        method: init.method,
        headers: {
          Accept: 'application/json',
          ...(init.headers ?? {}),
          ...sessionAuthHeaders(session),
        },
        body: init.body,
      }),
    );
  }
}

/** Bearer + Cookie headers for a logged-in session. */
function sessionAuthHeaders(session: SugSession): Record<string, string> {
  return { Authorization: `Bearer ${session.accessToken}`, Cookie: session.cookieHeader };
}

/**
 * Maps an HTTP response into an ApiResponse<T> or throws a domain error.
 * Used by both the v2/v3 JSON API and the legacy SUGboxAPI dispatcher —
 * the only difference is the envelope shape, captured by the normalizer.
 */
type Normalizer<T> = (raw: unknown) => ApiResponse<T> | null;

const normalizeKeyShape: Normalizer<unknown> = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ApiResponse<unknown>>;
  return { data: r.data, message: r.message ?? [], success: r.success ?? false };
};

const normalizeLegacyShape: Normalizer<unknown> = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<LegacyEnvelope<unknown>>;
  const m = r.MESSAGE;
  return {
    data: r.DATA,
    message: Array.isArray(m) ? m : m ? [m] : [],
    success: r.SUCCESS ?? false,
  };
};

async function parseEnvelope<T>(
  res: Response,
  context: string,
  normalize: Normalizer<T>,
): Promise<ApiResponse<T>> {
  const text = await res.text();
  const raw = parseJsonBody<unknown>(text);
  const parsed = raw !== null ? normalize(raw) : null;
  const msg = parsed?.message.join('; ');

  if (res.status === 401 || res.status === 403) throw new AuthError(res.status, msg);
  if (res.status === 404) throw new Error(`SignUpGenius 404 ${context}`);
  if (res.status >= 500) throw new UnreachableError('SignUpGenius', res.status);
  if (!res.ok) throw new Error(`SignUpGenius ${res.status} ${msg || res.statusText} for ${context}`);

  if (!parsed) {
    throw new Error(`SignUpGenius returned ${text === '' ? 'empty' : 'non-JSON'} body for ${context}`);
  }
  if (!parsed.success) {
    throw new Error(`SignUpGenius error: ${msg && msg.length > 0 ? msg : 'unknown'}`);
  }
  return parsed;
}

function parseJsonBody<T>(text: string): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * SignUpGenius rejected a request (401/403). Kept as a local class (rather
 * than the shared `SessionNotAuthenticatedError`, whose fixed browser-sign-in
 * message can't carry it) because the remediation is mode-dependent SUG
 * guidance — surfaced as the `hint` per the `McpToolError` contract.
 */
/**
 * A key-only feature was invoked while auth config was still deferred.
 *
 * Distinct from `ModeMismatchError` (which needs a *resolved* account to name
 * the current mode) and from the raw `configError` (whose browser/session
 * remediation does not apply to Pro-only endpoints). Slot reports live only on
 * the v2/k Pro surface — no v3 session equivalent exists — so no amount of
 * browser sign-in will satisfy them.
 */
export class KeyModeRequiredError extends McpToolError {
  private static readonly HINT =
    'Set SIGNUPGENIUS_USER_KEY (a SignUpGenius Pro API key). Signing into signupgenius.com in your ' +
    'browser cannot enable this — slot reports exist only on the Pro v2/k API, which uses a ' +
    'different auth scheme than the browser session.';

  constructor(featureLabel: string, configError?: Error | null) {
    super(
      `${featureLabel} requires Pro key mode. ${KeyModeRequiredError.HINT}` +
        (configError ? ` (auth is also unconfigured: ${configError.message})` : ''),
      { hint: KeyModeRequiredError.HINT },
    );
    this.name = 'KeyModeRequiredError';
  }
}

export class AuthError extends McpToolError {
  private static readonly HINT =
    'For key mode: check SIGNUPGENIUS_USER_KEY (it may be wrong, revoked, or the account no longer has Pro). ' +
    'For session mode: the session cookie may have been invalidated server-side.';

  constructor(readonly status: number, detail?: string) {
    super(
      `SignUpGenius rejected the request (${status}). ` +
        AuthError.HINT +
        (detail ? ` (${detail})` : ''),
      { hint: AuthError.HINT },
    );
    this.name = 'AuthError';
  }
}
