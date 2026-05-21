import type { Account } from './config.js';
import { sessionLogin as defaultSessionLogin } from './auth-session-login.js';

export type SessionLoginFn = typeof defaultSessionLogin;

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

export class SignUpGeniusClient {
  private account: Account | null;
  private configError: Error | null;
  private accessToken: string | null = null;
  private cookieHeader: string | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private sessionLoginFn: SessionLoginFn;

  /**
   * Accepts either a fully-resolved Account or a deferred error from
   * loadAccount. When `account` is null and `configError` is set, every
   * tool call surfaces the error — but the server still starts cleanly,
   * which is what the install-time smoke test requires.
   *
   * `preloaded` is the fetchproxy escape hatch: when set, the client uses
   * the supplied JWT + cookie header as-if it had just successfully run
   * `sessionLogin()`. On a 401 it falls back to the lazy login flow only if
   * usable credentials are present on the account — otherwise the 401
   * surfaces verbatim (re-sign-in is required in the browser).
   */
  constructor(
    account: Account | null,
    opts: {
      configError?: Error;
      sessionLogin?: SessionLoginFn;
      preloaded?: { accessToken: string; cookieHeader: string };
    } = {},
  ) {
    this.account = account;
    this.configError = opts.configError ?? null;
    this.sessionLoginFn = opts.sessionLogin ?? defaultSessionLogin;
    if (opts.preloaded) {
      this.accessToken = opts.preloaded.accessToken;
      this.cookieHeader = opts.preloaded.cookieHeader;
    }
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
    await this.ensureAuth();
    const url = `${acct.legacyBaseUrl}/index.cfm?go=s.PreProcessSignup&URLID=${encodeURIComponent(urlid)}`;
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
      },
      body: 'ScreenWidth=2000&ScreenHeight=1200',
    });
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
   * Fetch with auth attached. Session mode logs in lazily on first call and
   * re-mints credentials transparently on a 401. Key mode is stateless.
   */
  private async authedFetch(
    url: string,
    init: { method: string; body?: BodyInit; headers?: Record<string, string> },
    isRetry = false,
  ): Promise<Response> {
    await this.ensureAuth();
    const res = await fetch(url, {
      method: init.method,
      headers: { Accept: 'application/json', ...(init.headers ?? {}), ...this.authHeaders() },
      body: init.body,
    });

    if (res.status === 401 && this.account?.mode === 'session' && !isRetry) {
      // fetchproxy path has empty email/password — we can't re-login here.
      // Let the 401 propagate so the user is told to re-sign-in in the browser.
      if (this.account.email && this.account.password) {
        await this.ensureAuth({ force: true });
        return this.authedFetch(url, init, true);
      }
    }
    return res;
  }

  private authHeaders(): Record<string, string> {
    if (this.account?.mode === 'session') {
      return { Authorization: `Bearer ${this.accessToken!}`, Cookie: this.cookieHeader! };
    }
    return {}; // key mode: user_key is in the query string
  }

  private async ensureAuth(opts: { force?: boolean } = {}): Promise<void> {
    if (this.account?.mode !== 'session') return;
    if (!opts.force && this.accessToken && this.cookieHeader) return;
    if (this.refreshInFlight) return this.refreshInFlight;

    const acct = this.account;
    this.refreshInFlight = (async () => {
      const result = await this.sessionLoginFn({
        loginUrl: acct.loginBaseUrl,
        email: acct.email,
        password: acct.password,
      });
      this.accessToken = result.accessToken;
      this.cookieHeader = result.cookieHeader;
    })();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }
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
  if (res.status >= 500) throw new UnreachableError(res.status);
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

export class AuthError extends Error {
  constructor(public status: number, detail?: string) {
    super(
      `SignUpGenius rejected the request (${status}). ` +
        'For key mode: check SIGNUPGENIUS_USER_KEY (it may be wrong, revoked, or the account no longer has Pro). ' +
        'For session mode: the session cookie may have been invalidated server-side.' +
        (detail ? ` (${detail})` : ''),
    );
    this.name = 'AuthError';
  }
}

export class UnreachableError extends Error {
  constructor(public status: number) {
    super(`SignUpGenius unreachable (status ${status})`);
    this.name = 'UnreachableError';
  }
}

export class ModeMismatchError extends Error {
  constructor(
    public currentMode: Account['mode'],
    public requiredMode: Account['mode'],
    public feature: string,
  ) {
    super(
      `${feature} requires ${requiredMode} mode but the server is running in ${currentMode} mode. ` +
        (requiredMode === 'key'
          ? 'Set SIGNUPGENIUS_USER_KEY (Pro subscription required for the documented v2/k API).'
          : 'Set SIGNUPGENIUS_EMAIL + SIGNUPGENIUS_PASSWORD to enable this tool.'),
    );
    this.name = 'ModeMismatchError';
  }
}
