import { readEnvVar } from '@chrischall/mcp-utils';

export type Account = KeyAccount | SessionAccount;

export interface KeyAccount {
  mode: 'key';
  name: string;
  /** Base URL for the documented v2/k Pro API. */
  baseUrl: string;
  userKey: string;
}

export interface SessionAccount {
  mode: 'session';
  name: string;
  /** Base URL for the v3 web API used by signupgenius.com itself. */
  baseUrl: string;
  /** Base URL for the legacy SUGboxAPI dispatcher (cookie-authed). */
  legacyBaseUrl: string;
  /** Login form base (used by sessionLogin). */
  loginBaseUrl: string;
  email: string;
  password: string;
}

const DEFAULT_KEY_BASE_URL = 'https://api.signupgenius.com/v2/k';
const DEFAULT_V3_BASE_URL = 'https://api.signupgenius.com/v3';
const DEFAULT_LEGACY_BASE_URL = 'https://www.signupgenius.com';
const DEFAULT_LOGIN_BASE_URL = 'https://www.signupgenius.com';

/**
 * Read an env var and treat empty/placeholder values as unset. Some MCP hosts
 * stringify undefined user_config refs (Claude Desktop emits the literal
 * "undefined"; others leave the `${user_config.foo}` placeholder intact), and
 * a Bearer-style header built from those would silently authenticate as the
 * wrong identity or fail upstream with a confusing 403.
 *
 * Thin wrapper over `@chrischall/mcp-utils`'s `readEnvVar` so the explicit
 * `env`-source signature this module already passes around stays intact.
 */
function readVar(env: Record<string, string | undefined>, key: string): string | undefined {
  return readEnvVar(key, { env });
}

function requireHttps(value: string, varName: string): string {
  if (!/^https:\/\//.test(value)) {
    throw new Error(`${varName} must be an https URL, got: '${value}'`);
  }
  return value.replace(/\/$/, '');
}

export function loadAccount(env: Record<string, string | undefined> = process.env): Account {
  const userKey = readVar(env, 'SIGNUPGENIUS_USER_KEY');
  const email = readVar(env, 'SIGNUPGENIUS_EMAIL');
  const password = readVar(env, 'SIGNUPGENIUS_PASSWORD');

  const hasFullSession = !!email && !!password;
  const hasPartialSession = (!!email) !== (!!password);

  // Precedence: explicit user_key wins (the documented Pro path). Surface a
  // warning when both modes are configured so the user knows which one is
  // actually being used.
  if (userKey) {
    const baseUrlRaw = readVar(env, 'SIGNUPGENIUS_BASE_URL') ?? DEFAULT_KEY_BASE_URL;
    const baseUrl = requireHttps(baseUrlRaw, 'SIGNUPGENIUS_BASE_URL');
    const name = readVar(env, 'SIGNUPGENIUS_NAME') ?? new URL(baseUrl).host;
    if (hasFullSession) {
      console.error(
        '[signupgenius-mcp] SIGNUPGENIUS_USER_KEY takes precedence over SIGNUPGENIUS_EMAIL/PASSWORD — using key mode. ' +
          'Unset the key to use session mode.',
      );
    } else if (hasPartialSession) {
      console.error(
        `[signupgenius-mcp] Ignoring partial session credentials (only ${email ? 'EMAIL' : 'PASSWORD'} set) — using SIGNUPGENIUS_USER_KEY.`,
      );
    }
    return { mode: 'key', name, baseUrl, userKey };
  }

  if (hasPartialSession) {
    const missing = email ? 'SIGNUPGENIUS_PASSWORD' : 'SIGNUPGENIUS_EMAIL';
    throw new Error(
      `Incomplete session config — missing: ${missing}. ` +
        'Set both SIGNUPGENIUS_EMAIL and SIGNUPGENIUS_PASSWORD, or use SIGNUPGENIUS_USER_KEY instead.',
    );
  }

  if (hasFullSession) {
    const baseUrl = requireHttps(
      readVar(env, 'SIGNUPGENIUS_BASE_URL') ?? DEFAULT_V3_BASE_URL,
      'SIGNUPGENIUS_BASE_URL',
    );
    const legacyBaseUrl = requireHttps(
      readVar(env, 'SIGNUPGENIUS_LEGACY_BASE_URL') ?? DEFAULT_LEGACY_BASE_URL,
      'SIGNUPGENIUS_LEGACY_BASE_URL',
    );
    const loginBaseUrl = requireHttps(
      readVar(env, 'SIGNUPGENIUS_LOGIN_URL') ?? DEFAULT_LOGIN_BASE_URL,
      'SIGNUPGENIUS_LOGIN_URL',
    );
    const name = readVar(env, 'SIGNUPGENIUS_NAME') ?? email!;
    return {
      mode: 'session',
      name,
      baseUrl,
      legacyBaseUrl,
      loginBaseUrl,
      email: email!,
      password: password!,
    };
  }

  throw new Error(
    'Missing SignUpGenius auth config. Set SIGNUPGENIUS_USER_KEY (Pro API), ' +
      'or SIGNUPGENIUS_EMAIL + SIGNUPGENIUS_PASSWORD (session mode, free accounts).',
  );
}
