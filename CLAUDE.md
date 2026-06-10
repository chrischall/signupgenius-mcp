# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## TL;DR

MCP server for SignUpGenius — 14 read tools + 2 write across profile, groups, sign-ups, reports, public sign-up pages, and authenticated RSVPs.

Auth resolution lives in `src/auth.ts` (Pattern A template — see "Auth resolution" below). Three paths, priority order:

1. `SIGNUPGENIUS_USER_KEY` → Pro v2/k key mode (the only mode that can call slot reports).
2. `SIGNUPGENIUS_EMAIL` + `SIGNUPGENIUS_PASSWORD` → session-login (form POST → JWT + `cfid`/`cftoken` cookies → v3 API + legacy `/SUGboxAPI.cfm`).
3. fetchproxy fallback → `@fetchproxy/bootstrap` reads `accessToken` (a.k.a. `MTOKEN`) + `cfid` + `cftoken` cookies from the user's signed-in signupgenius.com browser tab. Bootstrap runs once at startup; from then on every API call goes out via direct Node `fetch()` with the cookies attached. Fetchproxy is **not** in the request hot path.

`SIGNUPGENIUS_DISABLE_FETCHPROXY=1` skips path 3 entirely and turns a missing/partial env config into a hard error at tool-call time — useful for headless CI where the browser bridge can't apply.

## Environment

No env vars are *required* — with none set, the server falls through to the fetchproxy browser bridge (path 3). The three auth paths and their env vars are resolved in `src/config.ts` (`loadAccount()`) and `src/auth.ts` (`resolveAuth()`). All vars pass through `readEnvVar` from `@chrischall/mcp-utils`, which treats empty/whitespace, the literal strings `"undefined"`/`"null"`, and unsubstituted `${...}` placeholders as unset (Claude Desktop sometimes emits these for blank `user_config` refs).

Priority order: **key > full session > fetchproxy > error**. A `SIGNUPGENIUS_USER_KEY` always wins; if both key and `EMAIL`/`PASSWORD` are present, `loadAccount()` logs a precedence warning to stderr and uses key mode.

```
# Path 1 — Pro v2/k API key (the only mode that can call slot reports)
SIGNUPGENIUS_USER_KEY=...                  # presence selects key mode
SIGNUPGENIUS_BASE_URL=...                  # optional override, must be https; default https://api.signupgenius.com/v2/k
SIGNUPGENIUS_NAME=...                      # optional display name; defaults to baseUrl host

# Path 2 — session email/password login (free accounts)
SIGNUPGENIUS_EMAIL=...                     # BOTH required together
SIGNUPGENIUS_PASSWORD=...                  # setting only one is a hard "Incomplete session config" error
SIGNUPGENIUS_BASE_URL=...                  # optional, must be https; default https://api.signupgenius.com/v3
SIGNUPGENIUS_LEGACY_BASE_URL=...           # optional, must be https; default https://www.signupgenius.com (the /SUGboxAPI.cfm dispatcher)
SIGNUPGENIUS_LOGIN_URL=...                 # optional, must be https; default https://www.signupgenius.com (sessionLogin form base)
SIGNUPGENIUS_NAME=...                      # optional display name; defaults to the email

# Path 3 — fetchproxy bootstrap (zero-config; default when no creds set)
SIGNUPGENIUS_DISABLE_FETCHPROXY=1          # opt out of path 3; missing creds then become a hard error
```

Non-https values for any `*_URL`/`*_BASE_URL` override throw `<var> must be an https URL`. Setting exactly one of `SIGNUPGENIUS_EMAIL`/`SIGNUPGENIUS_PASSWORD` throws an "Incomplete session config" error that propagates (it does **not** fall through to fetchproxy — only the "nothing set at all" case does).

**Deferred-config behavior:** `src/index.ts` wraps `resolveAuth()` in a try/catch and keeps the error in `configError` rather than throwing. The server always boots — so an MCP host can complete its install-time tool listing before the user has filled in `user_config` or signed into signupgenius.com. The same error message is re-raised at tool-call time by `SignUpGeniusClient.requireAccount()`. `signupgenius_get_public_signup` needs no auth and works even with a deferred config error.

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

## Architecture

Stdio MCP server. `src/index.ts` loads `.env` quietly, runs `resolveAuth()`, constructs one `SignUpGeniusClient`, and hands it to `runMcp()` from `@chrischall/mcp-utils` along with six tool-registration callbacks.

```
src/
  index.ts                # entry — loadDotenvSafely, resolveAuth() (deferred on error),
                          #   build SignUpGeniusClient, runMcp({ name, version, banner, deps, tools })
  config.ts               # loadAccount(env) → discriminated union Account = KeyAccount | SessionAccount; env-var
                          #   resolution + https validation + precedence warnings. Throws on missing/partial config.
  auth.ts                 # resolveAuth(): three-path priority (key/session env → fetchproxy bootstrap → error).
                          #   Catches only the "Missing SignUpGenius auth config" marker so partial-config errors propagate.
  auth-session-login.ts   # sessionLogin(): legacy form-POST login via sessionLoginFlow (@chrischall/mcp-utils).
                          #   Scrapes csrfToken, POSTs /index.cfm?go=c.Login, returns JWT + cookie header.
                          #   LoginFailedError on a c.Register failure-redirect (bad creds / SSO / 2FA unsupported).
  client.ts               # SignUpGeniusClient: request() routing (key=query user_key vs session=legacy SUGboxAPI),
                          #   CookieSessionManager for lazy login + 401/HTML-login expiry replay, preProcessSignUp(),
                          #   requireMode(), envelope normalizers. Error types: AuthError, UnreachableError, ModeMismatchError.
  tools/
    _shared.ts            # textContent() = textResult from @chrischall/mcp-utils (the standard MCP text block)
    user.ts               # registerUserTools — signupgenius_get_profile
    groups.ts             # registerGroupTools — list_groups, list/get_group_member, add_group_member (write)
    signups.ts            # registerSignUpTools — list_created_{active,expired,all}, list_invited/signedupfor, legacy_get_my_signups
    reports.ts            # registerReportTools — report_{all,filled,available} (Pro/key-only, requireMode('key'))
    public-signup.ts      # registerPublicSignUpTools — get_public_signup (no auth; scrapes the /go/ HTML page directly)
    rsvp.ts               # registerRsvpTool — signupgenius_rsvp (session-only write; PreProcessSignup→getSignupInfo→submit)
tests/                    # mirrors src/ (tests/tools/* for tool files). Mocks SignUpGeniusClient.request /
                          #   @fetchproxy/bootstrap / sessionLogin at the module boundary; no network.
```

Each `tools/*.ts` exports a `registerXxx…(server, client)` function — `registerXxxTools` (plural) for the multi-tool files, but the single-tool `rsvp.ts` exports `registerRsvpTool` (singular). (public-signup's is `(server, fetcher?)` since it bypasses the client.) `src/index.ts` wires all six. Schemas use the const-zod pattern: `const args = z.object({...})`; the SDK gets `args.shape`, the handler does `args.parse(raw)`.

Registration is mode-aware: `client.mode` (which defaults to `'session'` when config is deferred) chooses key-vs-session endpoint paths, gates the session-only `legacy_get_my_signups` and `signupgenius_rsvp` (skipped entirely outside session mode), while report tools always register but throw `ModeMismatchError` if invoked outside key mode.

## Tool surface

14 read + 2 write. Pro-only tools (slot reports) call `client.requireMode('key', …)` and throw `ModeMismatchError` in session/fetchproxy mode. The public-signup tool needs no auth and works even when `resolveAuth()` has deferred a config error.

Endpoint paths below are mode-dependent: key mode hits `/v2/k/...` (with `user_key` in the query string), session mode hits `/v3/...` or the legacy `/SUGboxAPI.cfm?go=<action>` dispatcher.

| Tool | File | Endpoint(s) | Mode | Kind |
| --- | --- | --- | --- | --- |
| `signupgenius_get_profile` | `tools/user.ts` | session `/member/profile` · key `/user/profile` | both | read |
| `signupgenius_list_groups` | `tools/groups.ts` | session `/groups/all` · key `/groups` | both | read |
| `signupgenius_list_group_members` | `tools/groups.ts` | `/groups/{id}/members` | both | read |
| `signupgenius_get_group_member` | `tools/groups.ts` | `/groups/{id}/members/{memberId}/details` | both | read |
| `signupgenius_add_group_member` | `tools/groups.ts` | `POST /groups/{id}/members/create` | both | **write** |
| `signupgenius_list_created_active` | `tools/signups.ts` | session `/signups/created` · key `/signups/created/active` | both | read |
| `signupgenius_list_created_expired` | `tools/signups.ts` | session `/signups/created` (alias) · key `/signups/created/expired` | both | read |
| `signupgenius_list_created_all` | `tools/signups.ts` | session `/signups/created` · key `/signups/created/all` | both | read |
| `signupgenius_list_invited` | `tools/signups.ts` | session `/signups/invited` · key `/signups/invited/active` | both | read |
| `signupgenius_list_signedupfor` | `tools/signups.ts` | session `/signups/signedupfor` · key `/signups/signedupfor/active` | both | read |
| `signupgenius_legacy_get_my_signups` | `tools/signups.ts` | legacy `SUGboxAPI.cfm?go=t.getMySignups` | session only | read |
| `signupgenius_report_all` | `tools/reports.ts` | `/signups/report/all/{signupId}` | **key only** | read |
| `signupgenius_report_filled` | `tools/reports.ts` | `/signups/report/filled/{signupId}` | **key only** | read |
| `signupgenius_report_available` | `tools/reports.ts` | `/signups/report/available/{signupId}` | **key only** | read |
| `signupgenius_get_public_signup` | `tools/public-signup.ts` | `GET /go/<slug>` HTML (direct `fetch`, bypasses client) | no auth | read |
| `signupgenius_rsvp` | `tools/rsvp.ts` | `s.PreProcessSignup` → `SUGboxAPI.cfm?go=s.getSignupInfo` → `s.processSignUpFormHandler` | session only | **write** |

### RSVP flow notes

`signupgenius_rsvp` only handles **RSVP-style** sheets (Yes/No/Maybe + optional guest counts). Under the hood it walks the same three-step browser flow the Angular wizard does:

1. `POST /index.cfm?go=s.PreProcessSignup&URLID=<urlid>` (form-encoded) — sets server-side session state. Implemented as `SignUpGeniusClient.preProcessSignUp(urlid)`.
2. `POST /SUGboxAPI.cfm?go=s.getSignupInfo` with `{ urlid }` — returns the full sign-up envelope. Used to gate on `useRSVP === 1` and pull `rsvpdetails.slotid`.
3. `POST /SUGboxAPI.cfm?go=s.processSignUpFormHandler` with the payload built by `buildRsvpPayload`.

**Slot-based sign-ups are explicitly rejected** by `signupgenius_rsvp` — they need `type:"standard"` + an `items` array + a separate `s.getSignUpFormItems` call. That's a different tool, not implemented yet.

## Quirks

- **Deferred config (`src/index.ts` + `client.ts`).** Missing/partial creds do NOT crash the server. `resolveAuth()`'s error is stashed in `configError`; the server boots, lists tools, and only re-raises the error when a tool actually calls `SignUpGeniusClient.requireAccount()`. This is required for the host's install-time smoke test. Don't "fix" it by throwing at startup.
- **Pro-only report tools.** `report_all`/`report_filled`/`report_available` call `client.requireMode('key', …)` and throw `ModeMismatchError` (pointing at `SIGNUPGENIUS_USER_KEY`) in session/fetchproxy mode. They still *register* in every mode so Claude knows they exist — only the invocation fails. The v3 web API has no report equivalent (none was found during recon).
- **RSVP-only vs slot-based.** `signupgenius_rsvp` handles *only* headcount RSVP sheets (`useRSVP === 1`). It rejects non-RSVP sheets and item-based RSVPs ("Yes, I'll bring lasagna", `rsvpdetails.rsvpitems` non-empty) with actionable errors. Slot-based "claim the 3pm slot" sheets are a separate, unimplemented tool.
- **`changemembermame` typo is load-bearing.** The RSVP wire payload preserves SignUpGenius's own misspelling. `RSVPITEMS` must always be emitted (as `[]` on headcount sheets) or the CFML `structKeyExists` validator throws `key [RSVPITEMS] doesn't exist`. Response `n` forces both guest counts to 0 regardless of input; `y`/`m` default to 1 adult / 0 children. See `buildRsvpPayload`.
- **fetchproxy is a one-shot bootstrap, not a hot-path proxy.** `@fetchproxy/bootstrap` reads `accessToken`/`MTOKEN` + `cfid`/`cftoken` cookies once at startup, then closes the bridge; every subsequent call is plain Node `fetch()` with those cookies. `accessToken` and `MTOKEN` carry the same JWT (`accessToken` preferred). On a 401 in fetchproxy mode the synthesized account has empty email/password, so the client *can't* re-login — it surfaces the expiry verbatim ("re-sign-in in the browser") rather than looping.
- **Two expiry signals.** `isSessionExpired` treats both a `401` and a `200` that renders the legacy HTML login page (matching `loginform`/`loginemail`/`go=c.Login`) as expiry → forces one re-login + replay. A `403` is a Pro-permission failure, not expiry, and is left alone.
- **Two envelope shapes.** The v2/v3 JSON API returns lower-case `{data, message, success}`; the legacy `/SUGboxAPI.cfm` dispatcher returns upper-case `{DATA, MESSAGE, SUCCESS}`. `normalizeKeyShape` / `normalizeLegacyShape` reconcile them so tools always see `ApiResponse<T>`.
- **public-signup bypasses the client.** It scrapes server-rendered `/go/` HTML via `globalThis.fetch` (injectable for tests) and regex-extracts landmarks — there's no JSON surface for it. That's why it needs no auth and survives a deferred config error.
- **100% coverage is enforced.** `vitest.config.ts` requires 100% lines/branches/functions/statements on `src/**` (excluding `src/index.ts`). Any new branch needs a test or CI fails — write the failing test first.
- **stdio transport: stderr only.** stdout is reserved for JSON-RPC; the startup banner and all logging go to stderr, and `.env` is loaded via `loadDotenvSafely` (quiet) so it can't corrupt the stream.
- **ESM + NodeNext.** Imports use `.js` extensions even for `.ts` sources.
- **`bin` vs bundle.** `package.json`'s `bin` points at `dist/index.js` (tsc output); `manifest.json` (the MCPB bundle) runs `dist/bundle.js` (single-file esbuild). `npm run build` produces both. `dist/` is gitignored; CI rebuilds it and the published tarball ships it.

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

**Exception for first-party dependency bumps.** When bumping a package we own (currently `@fetchproxy/bootstrap` — anything published from a chrischall-owned repo), label the PR `enhancement` or `bug` instead of `dependencies`, and use the matching commit prefix (`feat:` or `fix:`) instead of `chore:`. Those bumps deliver real product fixes or features through us, so they should drive a release-please version bump and show up under Features/Bug Fixes in the release notes — not get hidden under "Dependencies" (which doesn't trigger a release).

The **PR title** becomes the bullet — write it like a user-facing changelog entry, not internal shorthand. Conventional-commit prefixes (`feat:`, `fix:`, `chore:`) are still fine in commit messages, but the PR title should read clean.

### How PRs merge

**Don't run `gh pr merge` yourself.** The automation does it:

1. `pr-auto-review.yml` runs a Claude review on every PR **except** the release-please release PR (which it deliberately skips). On a `pass` verdict it adds the `ready-to-merge` label.
2. `auto-merge.yml`, on the `ready-to-merge` label (or on a dependabot PR), arms `gh pr merge --auto --squash`. The moment CI is green the PR squash-merges itself.

For ordinary feature/fix PRs, opening with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a release-notes line) is the whole job. If Claude's verdict was `warn`/`fail` but you've decided to ship anyway, add the label yourself: `gh pr edit <num> --add-label ready-to-merge`.

### PR timing — only open when the feature is done

Because PRs auto-merge as soon as auto-review passes, **do not open a PR until the feature is genuinely complete**. There's no draft-PR safety net here:

- Don't open a PR to "stage" work while live verification, follow-up fixes, or final passes are still pending — by the time you finish those, the half-baked PR may already be in `main`.
- Push commits to the branch first; only run `gh pr create` once tests pass, live verification (if applicable) is green, and you'd be comfortable with the change shipping as-is.
- If follow-ups land after a PR is already open, they need to land on the same branch *before* auto-review flips to `pass`. Once the PR squash-merges, late commits orphan onto a stale branch and become their own follow-up PR.
- If you genuinely need a checkpoint review without shipping, open the PR as a GitHub draft (`gh pr create --draft …`) — auto-review skips drafts. Mark it ready-for-review only when the feature is truly done.

**Release PRs are the one manual touch.** release-please opens its own release PR and leaves it open as your staging artifact — `pr-auto-review.yml` skips it on purpose, so it sits there accumulating changes until you decide to ship. When you're ready, add `ready-to-merge` to it the same way: `gh pr edit <num> --add-label ready-to-merge`. The `auto-merge.yml` arm then takes over and the publish job fires the moment the release PR lands.

The repo allows squash-merge only — `--merge` and `--rebase` are blocked at the branch-protection ruleset level.

## What to *not* do

- Don't reintroduce a `transport.ts` / `transport-fetchproxy.ts` layer between the client and Node fetch. The fetchproxy bootstrap is a one-shot cookie read at startup; per-request routing through the browser isn't needed here (SignUpGenius doesn't run an edge that revalidates each request, so plain Node fetch with the cookies from the bootstrap call works once you're authenticated).
- Don't paste real cookies into tests. Mock `@fetchproxy/bootstrap` at the module boundary.
- Don't break the "no env vars set" smoke-test path. The server must still start cleanly so MCP hosts can complete their install-time tool listing — `resolveAuth()` errors are deferred to tool-call time via `configError`.
