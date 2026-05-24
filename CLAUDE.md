# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## TL;DR

MCP server for SignUpGenius — 14 read tools + 2 write across profile, groups, sign-ups, reports, public sign-up pages, and authenticated RSVPs.

Auth resolution lives in `src/auth.ts` (Pattern A template — see "Auth resolution" below). Three paths, priority order:

1. `SIGNUPGENIUS_USER_KEY` → Pro v2/k key mode (the only mode that can call slot reports).
2. `SIGNUPGENIUS_EMAIL` + `SIGNUPGENIUS_PASSWORD` → session-login (form POST → JWT + `cfid`/`cftoken` cookies → v3 API + legacy `/SUGboxAPI.cfm`).
3. fetchproxy fallback → `@fetchproxy/bootstrap` reads `accessToken` (a.k.a. `MTOKEN`) + `cfid` + `cftoken` cookies from the user's signed-in signupgenius.com browser tab. Bootstrap runs once at startup; from then on every API call goes out via direct Node `fetch()` with the cookies attached. Fetchproxy is **not** in the request hot path.

`SIGNUPGENIUS_DISABLE_FETCHPROXY=1` skips path 3 entirely and turns a missing/partial env config into a hard error at tool-call time — useful for headless CI where the browser bridge can't apply.

## Auth resolution (Pattern A template)

`src/auth.ts` is the canonical "browser-bootstrap + Node-direct" shape used across our MCP family. Sibling MCPs (ofw-mcp, resy-mcp, opentable-mcp, …) follow the same structure — keep it flat, the path-selection explicit, and the error messages actionable.

- `src/auth.ts` — `resolveAuth()`: three-path priority. Reuses `loadAccount()` for env-var resolution, then falls through to bootstrap. Catches only the specific "Missing SignUpGenius auth config" error from `loadAccount()` — partial-config and validation errors still propagate.
- `src/auth-session-login.ts` — `sessionLogin()`: legacy form-POST. Isolated so tests can mock it at the module boundary.
- `src/config.ts` — `loadAccount()`: env-var resolution. Returns either a `KeyAccount`, `SessionAccount`, or throws.
- `src/client.ts` — `SignUpGeniusClient`: accepts a `preloaded` option. When set (fetchproxy path), the client uses the supplied JWT + cookie header as if it had just successfully run `sessionLogin()`. On a 401 in fetchproxy mode (empty email/password) we surface the error rather than loop on a bad re-login.

`@fetchproxy/bootstrap` is mocked at the module boundary in `tests/auth.test.ts`. None of the other test files import `bootstrap` — they exercise the existing env-var paths via `loadAccount()` / `SignUpGeniusClient` directly.

## Commands

- `npm test` — vitest, all mocked, no network. Must stay green.
- `npm run test:watch` — vitest watch.
- `npx vitest run tests/tools/<name>.test.ts` — run one file.
- `npx vitest run -t '<substring>'` — run one test by name.
- `npm run build` — `tsc` typecheck + esbuild bundle → `dist/bundle.js`.
- `npm run dev` — runs `dist/index.js` with `--env-file=.env` (build first).

`vitest.config.ts` enforces **100% lines/branches/functions/statements** on `src/**` (excl. `src/index.ts`). Coverage gaps fail CI — write the failing test first, then the code.

## Code layout

- `src/auth.ts`, `src/auth-session-login.ts`, `src/config.ts`, `src/client.ts` — see "Auth resolution" above.
- `src/index.ts` — entry point. Boots `McpServer`, calls `resolveAuth()`, wires the four tool-registration modules.
- `src/tools/` — one file per domain: `user.ts`, `groups.ts`, `signups.ts`, `reports.ts`, `public-signup.ts`, `rsvp.ts`, plus `_shared.ts` for `textContent()` and other helpers. Tests mirror this layout under `tests/tools/`.

## Tool surface

14 read + 2 write. Pro-only tools (slot reports) call `client.requireMode('key', …)` and throw `ModeMismatchError` in session/fetchproxy mode. The public-signup tool needs no auth and works even when `resolveAuth()` has deferred a config error.

| Domain | Tools | Mode |
| --- | --- | --- |
| Profile | `signupgenius_get_profile` | both |
| Groups | `signupgenius_list_groups`, `_list_group_members`, `_get_group_member`, `_add_group_member` (write) | both |
| Sign-ups | `_list_created_active`, `_expired`, `_all`, `_list_invited`, `_list_signedupfor` | both |
| Sign-ups (legacy) | `_legacy_get_my_signups` | session only |
| Reports | `_report_all`, `_report_filled`, `_report_available` | **key only** |
| Public page | `_get_public_signup` | no auth |
| RSVP | `_rsvp` (write) | session only |

### RSVP flow notes

`signupgenius_rsvp` only handles **RSVP-style** sheets (Yes/No/Maybe + optional guest counts). Under the hood it walks the same three-step browser flow the Angular wizard does:

1. `POST /index.cfm?go=s.PreProcessSignup&URLID=<urlid>` (form-encoded) — sets server-side session state. Implemented as `SignUpGeniusClient.preProcessSignUp(urlid)`.
2. `POST /SUGboxAPI.cfm?go=s.getSignupInfo` with `{ urlid }` — returns the full sign-up envelope. Used to gate on `useRSVP === 1` and pull `rsvpdetails.slotid`.
3. `POST /SUGboxAPI.cfm?go=s.processSignUpFormHandler` with the payload built by `buildRsvpPayload`.

**Slot-based sign-ups are explicitly rejected** by `signupgenius_rsvp` — they need `type:"standard"` + an `items` array + a separate `s.getSignUpFormItems` call. That's a different tool, not implemented yet.

## Conventions

- All tools are `signupgenius_*`-prefixed.
- Tool return shape: `{ content: [{ type: 'text', text: JSON.stringify(..., null, 2) }] }`.
- Write a failing test before implementation (TDD). Tool tests live in `tests/tools/<name>.test.ts` and mock `SignUpGeniusClient.request`.
- Don't add WS-server or protocol-frame logic here. That lives upstream in `@fetchproxy/server` (consumed via `@fetchproxy/bootstrap`). Bugs in extension handshaking, frame validation, or service-worker keepalive belong in the fetchproxy repo.

## Publishing constraints

The MCP Registry's [server.schema.json](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json) caps `server.json`'s `description` at **100 characters**. Values over that fail `mcp-publisher publish` with HTTP 422 (`validation failed: expected length <= 100, location: body.description`). The other description fields (`manifest.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) have no published length constraint and can stay longer.

Sanity-check before committing a description change:

```bash
jq -r '.description | length' server.json
```

## Versioning

Version appears in several places — all must match: `package.json`, `package-lock.json`, `src/index.ts` (`McpServer` constructor), `manifest.json`, `server.json`. Don't bump manually unless explicitly asked — versioning is automated.

## Pull requests & release notes

**Default workflow: branch + PR, even for solo work.** Direct pushes to `main` skip review *and* the auto-generated release notes block (configured in `.github/release.yml`).

For every PR, apply exactly one label:

| Label                  | Section in release notes |
|------------------------|--------------------------|
| `enhancement`          | Features                 |
| `bug`                  | Bug Fixes                |
| `security`             | Security                 |
| `refactor`             | Refactor                 |
| `documentation`        | Documentation            |
| `test`                 | Tests                    |
| `dependencies`         | Dependencies             |
| `ci` / `github_actions`| CI & Build               |
| *(none / unmatched)*   | Other Changes            |
| `ignore-for-release`   | Hidden from notes        |

The **PR title** becomes the bullet — write it like a user-facing changelog entry, not internal shorthand. Conventional-commit prefixes (`feat:`, `fix:`, `chore:`) are still fine in commit messages, but the PR title should read clean.

### How PRs merge

**Don't run `gh pr merge` yourself.** The automation does it:

1. `pr-auto-review.yml` runs a Claude review on every PR **except** the release-please release PR (which it deliberately skips). On a `pass` verdict it adds the `ready-to-merge` label.
2. `auto-merge.yml`, on the `ready-to-merge` label (or on a dependabot PR), arms `gh pr merge --auto --squash`. The moment CI is green the PR squash-merges itself.

For ordinary feature/fix PRs, opening with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a release-notes line) is the whole job. If Claude's verdict was `warn`/`fail` but you've decided to ship anyway, add the label yourself: `gh pr edit <num> --add-label ready-to-merge`.

**Release PRs are the one manual touch.** release-please opens its own release PR and leaves it open as your staging artifact — `pr-auto-review.yml` skips it on purpose, so it sits there accumulating changes until you decide to ship. When you're ready, add `ready-to-merge` to it the same way: `gh pr edit <num> --add-label ready-to-merge`. The `auto-merge.yml` arm then takes over and the publish job fires the moment the release PR lands.

The repo allows squash-merge only — `--merge` and `--rebase` are blocked at the branch-protection ruleset level.

## What to *not* do

- Don't reintroduce a `transport.ts` / `transport-fetchproxy.ts` layer between the client and Node fetch. The fetchproxy bootstrap is a one-shot cookie read at startup; per-request routing through the browser isn't needed here (SignUpGenius doesn't run an edge that revalidates each request, so plain Node fetch with the cookies from the bootstrap call works once you're authenticated).
- Don't paste real cookies into tests. Mock `@fetchproxy/bootstrap` at the module boundary.
- Don't break the "no env vars set" smoke-test path. The server must still start cleanly so MCP hosts can complete their install-time tool listing — `resolveAuth()` errors are deferred to tool-call time via `configError`.
