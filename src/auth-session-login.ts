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
 * The mechanics (CSRF scrape, cookie jar, form POST, success-marker cookie)
 * are delegated to `sessionLoginFlow` from `@chrischall/mcp-utils` — this
 * module was the donor that primitive was extracted from, so only the
 * SUG-specific bits remain here: the form-field names, the static form
 * params, and the `c.Register` failure-redirect classification (the shared
 * flow has no failure-classifier hook, so we sniff the credential POST's
 * `Location` header via the injectable fetch and translate in a catch).
 *
 * SSO accounts (Google/Apple/Facebook/Microsoft) and 2FA-enabled accounts are
 * unsupported — same caveat as canvas-parent-mcp's session mode.
 */

import { sessionLoginFlow } from '@chrischall/mcp-utils';

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

  // A failed login 302s to /index.cfm?go=c.Register (the configured failpage).
  // The shared flow only reports "no accessToken cookie" — record the credential
  // POST's redirect target so we can give the clearer bad-credentials message.
  let postLocation = '';
  const locationRecordingFetch: typeof fetch = async (url, init) => {
    const res = await fetch(url, init);
    if (init?.method === 'POST') {
      postLocation = res.headers.get('location') ?? '';
    }
    return res;
  };

  try {
    const { token, cookies } = await sessionLoginFlow({
      loginUrl: `${base}/login`,
      postUrl: `${base}/index.cfm?go=c.Login`,
      csrfRegex: /name="csrfToken"\s+value="([^"]+)"/,
      tokenField: 'accessToken',
      emailField: 'loginemail',
      passwordField: 'pword',
      email: input.email,
      password: input.password,
      extraFields: {
        successpage: 'c.jump&jump=/index.cfm?go=c.MyAccount',
        failpage: 'c.Register',
        ScreenWidth: '2000',
        ScreenHeight: '1200',
        formaction: '1',
        formName: 'loginform',
        refererUrl: '',
      },
      userAgent: USER_AGENT,
      fetchImpl: locationRecordingFetch,
    });
    return { accessToken: token, cookieHeader: cookies };
  } catch (err) {
    if (postLocation.includes('c.Register')) {
      throw new LoginFailedError('login form rejected the credentials');
    }
    throw new LoginFailedError(err instanceof Error ? err.message : String(err));
  }
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

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
