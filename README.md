# signupgenius-mcp

MCP server for [SignUpGenius](https://www.signupgenius.com). 13 read tools and 1 write across profile, groups, sign-ups, and reports.

Three auth modes (tried in this priority order — first match wins):
1. **Pro key mode.** Uses the documented Pro API key. Required only for the slot REPORT tools (filled/available/all-participants). Pro subscription needed.
2. **Session mode.** Logs in with your normal email/password to call the same web API the signupgenius.com dashboard uses. **Free accounts work.** No SSO/2FA.
3. **fetchproxy fallback (no env vars needed).** When no env vars are set, the server reads `accessToken` / `cfid` / `cftoken` cookies once at startup from your already-signed-in `signupgenius.com` tab via the [fetchproxy](https://github.com/chrischall/fetchproxy) browser extension. After that one read, all SignUpGenius API calls go directly from Node — the extension is **not** in the request hot path. Install the extension once, sign into SignUpGenius, and the MCP just works.

Set `SIGNUPGENIUS_DISABLE_FETCHPROXY=1` to opt out of the fallback (turns missing credentials into a hard error — useful in headless CI).

## Tools

| Domain | Tools | Mode |
|---|---|---|
| Profile | `signupgenius_get_profile` | both |
| Groups | `signupgenius_list_groups`, `signupgenius_list_group_members`, `signupgenius_get_group_member`, `signupgenius_add_group_member` (write) | both |
| Sign-ups | `signupgenius_list_created_active`, `_expired`, `_all`, `signupgenius_list_invited`, `signupgenius_list_signedupfor` | both |
| Sign-ups (extras) | `signupgenius_legacy_get_my_signups` | session only |
| Reports | `signupgenius_report_all`, `signupgenius_report_filled`, `signupgenius_report_available` | **key only** |

Notes on session-mode sign-up listings: the v3 endpoints `signups/created`, `signups/invited`, and `signups/signedupfor` return the full list in one paginated call (no separate active/expired URLs). The three `signupgenius_list_created_*` tools all map to the same endpoint in session mode; filter by `enddate` client-side. The bonus `signupgenius_legacy_get_my_signups` calls the same backend the SignUpGenius wizard itself uses and sometimes returns fuller data.

Reports in session mode fail fast with a clear `ModeMismatchError` telling the user to set `SIGNUPGENIUS_USER_KEY`.

## Configuration

### Session mode (recommended)

```
SIGNUPGENIUS_EMAIL=you@example.com
SIGNUPGENIUS_PASSWORD=your-password
SIGNUPGENIUS_NAME=Family               # optional, log label only
```

The server logs into signupgenius.com on first request, caches the JWT and session cookies, and silently re-logs in on a 401. Treat `.env` like a password file — it's gitignored here, do not commit.

**Direct email/password accounts only.** Won't work with Google/Apple/Facebook/Microsoft SSO or 2FA, same caveat as similar sibling MCPs.

### Key mode (Pro only)

```
SIGNUPGENIUS_USER_KEY=your-api-key
SIGNUPGENIUS_NAME=PTA Org              # optional
```

Find the user key in SignUpGenius under **Pro Tools → API Management**.

### fetchproxy fallback (no env vars)

Install the [fetchproxy extension](https://github.com/chrischall/fetchproxy) (Chrome Web Store / Safari `.dmg`), sign into [signupgenius.com](https://www.signupgenius.com), and remove the env block from your MCP config. The MCP reads `accessToken` / `cfid` / `cftoken` cookies once at startup and uses them like a session-mode login. No password copy-paste required.

The slot REPORT tools still require Pro key mode — `SIGNUPGENIUS_USER_KEY` is the only path that hits the documented v2/k Pro API.

### Both at once

Set both Pro key and email/password. Key mode wins. Useful if you have Pro for some accounts and want reports while still using your normal login elsewhere.

### Advanced overrides

| Env var | Default | Purpose |
|---|---|---|
| `SIGNUPGENIUS_BASE_URL` | key: `https://api.signupgenius.com/v2/k`<br>session: `https://api.signupgenius.com/v3` | Override the JSON API base. |
| `SIGNUPGENIUS_LEGACY_BASE_URL` | `https://www.signupgenius.com` | Override the host for `/SUGboxAPI.cfm?go=…` legacy calls. |
| `SIGNUPGENIUS_LOGIN_URL` | `https://www.signupgenius.com` | Override the login form host. |
| `SIGNUPGENIUS_DISABLE_FETCHPROXY` | unset | Set to `1` to skip the fetchproxy fallback (missing creds become a hard error). |

## ToS caveat

SignUpGenius's terms generally prohibit scripted/automated access. Session mode is "your own account, your own risk" — fine for personal automation but not something you should run at scale or on accounts you don't own.

## Local dev

```
npm install
npm run build
npm test
```

Point an MCP host at `dist/bundle.js` with the env vars above, or run `npm run dev` after creating a `.env`.

Tests: vitest, 100% line/branch/function coverage. End-to-end tests against the SignUpGenius API are not in CI by design — running them requires real credentials.

## Notes

- The Pro v2/k API authenticates via a `user_key` query param. The session API uses a JWT Bearer + session cookie. The client picks the right one based on which env vars you set.
- All response envelopes are normalized to `{ data, message, success }` (lowercase) regardless of which surface served the request — the legacy SUGboxAPI dispatcher's uppercase envelope is rewritten internally.
- For testing the Pro v2/k surface without an account, SignUpGenius publishes a frozen demo key: `V0FzMkxZcmVOZlVnclZMVEl6dGhWQT09`.

Developed and maintained by AI (Claude). Use at your own discretion.
