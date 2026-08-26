import {
  createFileStatePersistence,
  resolveStateFile,
  type PersistedCookieSession,
  type SyncStatePersistence,
} from '@chrischall/mcp-utils/session';
import { readEnvVar, parseBoolEnv } from '@chrischall/mcp-utils';

/** The cookie session this server persists: the JWT plus its cookie header. */
export interface SugSessionRecord {
  accessToken: string;
  cookieHeader: string;
}

/**
 * Where the signed-in session is cached between runs.
 *
 * The SignUpGenius JWT lives about 30 minutes. A hosted child idles out after
 * ten, so a restart inside that window was re-running the whole form login for a
 * session that had not expired. Caching it makes those restarts free; a session
 * that HAS expired costs exactly what it did before, because `isExpired` still
 * catches it on the first request and replays after a re-login.
 */
export function sessionCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveStateFile({
    env,
    envVar: 'SIGNUPGENIUS_SESSION_FILE',
    subdir: '.signupgenius-mcp',
    fileName: 'session.json',
  });
}

/** Guard the stored envelope: a session with both halves, and a login time. */
function isRecord(raw: unknown): raw is PersistedCookieSession<SugSessionRecord> {
  if (raw === null || typeof raw !== 'object') return false;
  const r = raw as Partial<PersistedCookieSession<SugSessionRecord>>;
  if (typeof r.sessionAt !== 'number') return false;
  const s = r.session as Partial<SugSessionRecord> | undefined;
  if (s === null || typeof s !== 'object') return false;
  return (
    typeof s.accessToken === 'string' &&
    s.accessToken !== '' &&
    typeof s.cookieHeader === 'string' &&
    s.cookieHeader !== ''
  );
}

/** Options for {@link createSessionCache}. */
export interface SessionCacheOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * True when the client was given a `refreshSession` function — the fetchproxy
   * path, which re-reads a signed-in browser tab on every expiry.
   */
  browserBacked?: boolean;
}

/**
 * The session cache, or `null` when it must not be used.
 *
 * Three ways it comes back `null`:
 *
 *  - `SIGNUPGENIUS_SESSION_CACHE=false` — the operator opted out.
 *  - **The fetchproxy path.** Its session comes from a signed-in browser tab
 *    rather than a stored secret, so there is nothing stable to bind a record
 *    to, and re-reading the tab is already cheap. That path is local-only, where
 *    cold starts are rare anyway.
 *  - **No email/password.** Key mode (`SIGNUPGENIUS_USER_KEY`) mints no session
 *    at all, so there is nothing to cache.
 *
 * The record is bound to the credentials that minted it, so rotating either
 * discards it. Only a salted digest is written; neither value reaches the file.
 */
export function createSessionCache(
  opts: SessionCacheOptions = {},
): SyncStatePersistence<PersistedCookieSession<SugSessionRecord>> | null {
  const env = opts.env ?? process.env;
  if (opts.browserBacked === true) return null;
  if (!parseBoolEnv('SIGNUPGENIUS_SESSION_CACHE', { env, default: true })) return null;
  const email = readEnvVar('SIGNUPGENIUS_EMAIL', { env });
  const password = readEnvVar('SIGNUPGENIUS_PASSWORD', { env });
  if (email === undefined || password === undefined) return null;

  return createFileStatePersistence<PersistedCookieSession<SugSessionRecord>>({
    filePath: sessionCachePath(env),
    // Joined on a NUL so a different email/password pair cannot collide with
    // this one by shifting the boundary between the two halves.
    boundTo: [email.trim().toLowerCase(), password].join('\u0000'),
    validate: (raw) => (isRecord(raw) ? raw : null),
  });
}

/**
 * Report a cache write that failed. Not fatal: the session is re-mintable from
 * the credentials in the environment, so a lost write costs the next start a
 * login rather than access. Worth saying, though — a read-only data dir
 * otherwise looks exactly like a server that never caches.
 *
 * stderr only; stdout is the JSON-RPC channel.
 */
export function reportCacheWriteFailure(err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(
    `[signupgenius-mcp] could not cache the session (${detail}); continuing without the ` +
      'cache — every restart will log in again until this is fixed.',
  );
}
