import type { McpServer } from '@modelcontextprotocol/server';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { SignUpGeniusClient } from '../client.js';

/**
 * Register `signupgenius_healthcheck` — reports which auth mode is in play,
 * then makes one authenticated call to the profile endpoint.
 *
 * SignUpGenius has two modes that fail differently and are easy to confuse:
 * `key` mode uses an API key against `/v2/k/...`, and `session` mode uses a
 * session — from an email/password form login or lifted from the browser by
 * fetchproxy — against `/v3/member/...`. A tool that
 * 404s because the wrong mode is active looks nothing like an auth problem, so
 * the mode is reported explicitly alongside the endpoint it implies.
 *
 * The probe follows the same mode switch the real tools use, so a passing
 * healthcheck means real tools work rather than that some other endpoint does.
 */
const REJECTED_HINTS = {
  'api key':
    'SignUpGenius rejected the API key. Check SIGNUPGENIUS_USER_KEY — it may be wrong, revoked, or the account may no longer have Pro.',
  'email/password session':
    'SignUpGenius rejected the email/password login. Check SIGNUPGENIUS_EMAIL and SIGNUPGENIUS_PASSWORD (a changed password, or an account that signs in only via Google/Apple, will fail).',
  'fetchproxy session':
    'SignUpGenius rejected the browser session. Sign into signupgenius.com in the browser so the fetchproxy fallback can lift a fresh session.',
} as const;

const GENERIC_REJECTED_HINT =
  'SignUpGenius rejected the credential. In key mode, check SIGNUPGENIUS_USER_KEY; with email/password, check SIGNUPGENIUS_EMAIL and SIGNUPGENIUS_PASSWORD; otherwise sign into signupgenius.com in the browser so the fetchproxy fallback can lift a fresh session.';

export function registerHealthcheckTools(server: McpServer, client: SignUpGeniusClient): void {
  // Resolved once: the auth source is fixed at startup, and the hint has to
  // name the fix for the source actually in use (fleet-audit#705).
  const source = client.authSource;
  registerCredentialHealthcheckTool({
    server,
    prefix: 'signupgenius',
    hostLabel: 'api.signupgenius.com',
    resolveCredential: async () => ({
      source: source ?? `${client.mode} (auth not configured)`,
      detail: {
        mode: client.mode,
        profile_endpoint: client.mode === 'session' ? '/v3/member/profile' : '/v2/k/user/profile',
      },
    }),
    probeFn: () => client.request(client.mode === 'session' ? '/member/profile' : '/user/profile'),
    hints: {
      credential_rejected: source ? REJECTED_HINTS[source] : GENERIC_REJECTED_HINT,
    },
  });
}
