import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { SignUpGeniusClient } from '../client.js';

/**
 * Register `signupgenius_healthcheck` — reports which auth mode is in play,
 * then makes one authenticated call to the profile endpoint.
 *
 * SignUpGenius has two modes that fail differently and are easy to confuse:
 * `key` mode uses an API key against `/v2/k/...`, and `session` mode uses a
 * browser session lifted by fetchproxy against `/v3/member/...`. A tool that
 * 404s because the wrong mode is active looks nothing like an auth problem, so
 * the mode is reported explicitly alongside the endpoint it implies.
 *
 * The probe follows the same mode switch the real tools use, so a passing
 * healthcheck means real tools work rather than that some other endpoint does.
 */
export function registerHealthcheckTools(server: McpServer, client: SignUpGeniusClient): void {
  registerCredentialHealthcheckTool({
    server,
    prefix: 'signupgenius',
    hostLabel: 'api.signupgenius.com',
    resolveCredential: async () => ({
      source: client.mode === 'session' ? 'fetchproxy session' : 'api key',
      detail: {
        mode: client.mode,
        profile_endpoint: client.mode === 'session' ? '/v3/member/profile' : '/v2/k/user/profile',
      },
    }),
    probeFn: () => client.request(client.mode === 'session' ? '/member/profile' : '/user/profile'),
    hints: {
      credential_rejected:
        'SignUpGenius rejected the credential. In key mode, check SIGNUPGENIUS_API_KEY; in session mode, sign into signupgenius.com in the browser so the fetchproxy fallback can lift a fresh session.',
    },
  });
}
