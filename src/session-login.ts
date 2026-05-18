/**
 * Logs in to signupgenius.com with email+password and returns the JWT access
 * token plus the cookies needed by the legacy SUGboxAPI.cfm dispatcher.
 *
 * Flow (reverse-engineered from the public login page):
 *   1. GET /login — page contains a `csrfToken` hidden input and sets
 *      cfid/cftoken cookies.
 *   2. POST /index.cfm?go=c.Login with the form fields the page would submit,
 *      including the scraped csrfToken. On success the server 302s and sets
 *      an `accessToken` JWT cookie scoped to .signupgenius.com.
 *
 * SSO accounts (Google/Apple/Facebook/Microsoft) and 2FA-enabled accounts are
 * unsupported — same caveat as canvas-parent-mcp's session mode.
 */

export interface SessionLoginInput {
  loginUrl?: string; // override for testing
  email: string;
  password: string;
}

export interface SessionLoginResult {
  /** Bearer token for api.signupgenius.com/v3 endpoints. */
  accessToken: string;
  /** Cookie header value for legacy SUGboxAPI.cfm calls (cfid/cftoken/accessToken). */
  cookieHeader: string;
}

const DEFAULT_LOGIN_BASE = 'https://www.signupgenius.com';

export async function sessionLogin(input: SessionLoginInput): Promise<SessionLoginResult> {
  const base = input.loginUrl ?? DEFAULT_LOGIN_BASE;
  const jar = new CookieJar();

  // Step 1: fetch login page, extract csrfToken
  const loginPage = await fetch(`${base}/login`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
  });
  if (!loginPage.ok) {
    throw new LoginFailedError(`login page returned ${loginPage.status}`);
  }
  jar.absorb(loginPage.headers);
  const html = await loginPage.text();
  const csrfMatch = /name="csrfToken"\s+value="([^"]+)"/.exec(html);
  if (!csrfMatch) {
    throw new LoginFailedError('csrfToken not found on login page');
  }
  const csrfToken = csrfMatch[1]!;

  // Step 2: POST credentials
  const body = new URLSearchParams({
    csrfToken,
    loginemail: input.email,
    pword: input.password,
    successpage: 'c.jump&jump=/index.cfm?go=c.MyAccount',
    failpage: 'c.Register',
    ScreenWidth: '2000',
    ScreenHeight: '1200',
    formaction: '1',
    formName: 'loginform',
    refererUrl: '',
  }).toString();

  const postRes = await fetch(`${base}/index.cfm?go=c.Login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${base}/login`,
      Cookie: jar.header(),
    },
    body,
  });
  jar.absorb(postRes.headers);

  // A successful login redirects to /index.cfm?go=c.MyAccount. A failed login
  // 302s to /index.cfm?go=c.Register (the configured failpage) or returns 200
  // with the login page rerendered. Either way, no accessToken cookie is set.
  const accessToken = jar.get('accessToken');
  if (!accessToken) {
    const location = postRes.headers.get('location') ?? '';
    const detail = location.includes('c.Register')
      ? 'login form rejected the credentials'
      : `login did not yield an accessToken (status ${postRes.status})`;
    throw new LoginFailedError(detail);
  }

  return { accessToken, cookieHeader: jar.header() };
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** Minimal Netscape-cookie-style jar — only tracks name/value, no domain matching. */
class CookieJar {
  private cookies = new Map<string, string>();

  absorb(headers: Headers): void {
    const setCookies = readSetCookieHeaders(headers);
    for (const raw of setCookies) {
      const semi = raw.indexOf(';');
      const pair = semi >= 0 ? raw.slice(0, semi) : raw;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      this.cookies.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

/**
 * Node's Headers can carry multiple Set-Cookie values; Headers.get joins them
 * with ", " which breaks parsing because cookie attributes also use commas
 * (Expires=Wed, 17 Jun 2026 ...). Headers.getSetCookie() is the spec'd way
 * (Node ≥19, undici ≥5.2) — fall back to the single-string getter for older
 * runtimes by splitting only on commas that precede a `name=` token.
 */
function readSetCookieHeaders(headers: Headers): string[] {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') {
    return anyHeaders.getSetCookie();
  }
  const raw = headers.get('set-cookie');
  if (!raw) return [];
  return raw.split(/,(?=\s*[A-Za-z0-9_-]+=)/);
}

export class LoginFailedError extends Error {
  constructor(public detail: string) {
    super(
      `SignUpGenius login failed: ${detail}. ` +
        'Verify SIGNUPGENIUS_EMAIL / SIGNUPGENIUS_PASSWORD. ' +
        'SSO accounts (Google/Apple/Facebook/Microsoft) and 2FA-enabled accounts are not supported in session mode.',
    );
    this.name = 'LoginFailedError';
  }
}
