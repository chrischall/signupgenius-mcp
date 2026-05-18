# signupgenius-mcp

MCP server for [SignUpGenius](https://www.signupgenius.com). 13 read tools and 1 write across profile, groups, sign-ups, and reports.

Two auth modes:
- **Session mode (recommended).** Logs in with your normal email/password to call the same web API the signupgenius.com dashboard uses. **Free accounts work.** No SSO/2FA.
- **Key mode.** Uses the documented Pro API key. Required only for the slot REPORT tools (filled/available/all-participants). Pro subscription needed.

Both modes can be configured at the same time — set `SIGNUPGENIUS_USER_KEY` to force key mode, otherwise email/password takes effect.

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

### Both at once

Set both. Key mode wins. Useful if you have Pro for some accounts and want reports while still using your normal login elsewhere.

### Advanced overrides

| Env var | Default | Purpose |
|---|---|---|
| `SIGNUPGENIUS_BASE_URL` | key: `https://api.signupgenius.com/v2/k`<br>session: `https://api.signupgenius.com/v3` | Override the JSON API base. |
| `SIGNUPGENIUS_LEGACY_BASE_URL` | `https://www.signupgenius.com` | Override the host for `/SUGboxAPI.cfm?go=…` legacy calls. |
| `SIGNUPGENIUS_LOGIN_URL` | `https://www.signupgenius.com` | Override the login form host. |

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
