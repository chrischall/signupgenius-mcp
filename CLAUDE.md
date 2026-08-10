# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## TL;DR

MCP server for SignUpGenius — 15 read tools + 4 write across profile, groups, sign-ups, reports, public sign-up metadata, slot listings, authenticated RSVPs, and slot claim/release.

Auth resolution lives in `src/auth.ts` (Pattern A template — see "Auth resolution" below). Three paths, priority order:

1. `SIGNUPGENIUS_USER_KEY` → Pro v2/k key mode (the only mode that can call slot reports).
2. `SIGNUPGENIUS_EMAIL` + `SIGNUPGENIUS_PASSWORD` → session-login (form POST → JWT + `cfid`/`cftoken` cookies → v3 API + legacy `/SUGboxAPI.cfm`).
3. fetchproxy fallback → `@fetchproxy/bootstrap` reads `accessToken` (a.k.a. `MTOKEN`) + `cfid` + `cftoken` + `refreshToken` cookies from the user's signed-in signupgenius.com browser tab, **at the `www` host** (the apex exposes only `accessToken`). The lift runs lazily per login — first request and every expiry — not once at startup, and exchanges a stale JWT via `POST /v3/auth/refresh`. Between lifts every API call goes out via direct Node `fetch()` with the cookies attached. Fetchproxy is **not** in the request hot path.

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
                          #   requireMode(), envelope normalizers. Error types: local AuthError (extends McpToolError,
                          #   SUG key/session guidance as hint); UnreachableError + ModeMismatchError re-exported
                          #   from @chrischall/mcp-utils.
  tools/
    _shared.ts            # textContent() = textResult from @chrischall/mcp-utils (the standard MCP text block)
    user.ts               # registerUserTools — signupgenius_get_profile
    groups.ts             # registerGroupTools — list_groups, list/get_group_member, add_group_member (write)
    signups.ts            # registerSignUpTools — list_created_{active,expired,all}, list_invited/signedupfor, legacy_get_my_signups
    reports.ts            # registerReportTools — report_{all,filled,available} (Pro/key-only, requireKeyMode())
    sug-legacy.ts         # legacyPost() + HTML→text helpers for the unauthenticated
                          #   /SUGboxAPI.cfm dispatcher. The injectable Fetcher type lives here.
    public-signup.ts      # registerPublicSignUpTool — get_public_signup
                          #   (no auth; POST s.getSignupInfo — NOT an HTML scrape)
    slots.ts              # registerSlotTools — list_slots (no auth; GET /v3/signups/{id}/slots
                          #   merged with s.getSignUpParticipantsBySlotItem for names + myqty)
    rsvp.ts               # registerRsvpTool — signupgenius_rsvp (session-only write; PreProcessSignup→getSignupInfo→submit)
    slot-write.ts         # registerSlotWriteTools — claim_slot / release_slot (session-only writes,
                          #   both gated behind a confirm:true dry-run preview)
tests/                    # mirrors src/ (tests/tools/* for tool files). Mocks SignUpGeniusClient.request /
                          #   @fetchproxy/bootstrap / sessionLogin at the module boundary; no network.
```

Each `tools/*.ts` exports a `registerXxx…(server, client)` function — `registerXxxTools` (plural) for the multi-tool files, but the single-tool `rsvp.ts` and `public-signup.ts` export `registerRsvpTool` / `registerPublicSignUpTool` (singular). `public-signup.ts` and `slots.ts` take `(server, fetcher?)` instead of a client, since both bypass it entirely — their endpoints need no auth. `src/index.ts` wires all eight. Schemas use the const-zod pattern: `const args = z.object({...})`; the SDK gets `args.shape`, the handler does `args.parse(raw)`.

Registration is mode-aware: `client.mode` (which defaults to `'session'` when config is deferred) chooses key-vs-session endpoint paths, gates the session-only `legacy_get_my_signups` and `signupgenius_rsvp` (skipped entirely outside session mode), while report tools always register but throw `ModeMismatchError` / `KeyModeRequiredError` if invoked outside key mode.

## Tool surface

15 read + 2 write. Pro-only tools (slot reports) call `client.requireKeyMode(…)` and throw `ModeMismatchError` (or `KeyModeRequiredError` when config was deferred) in session/fetchproxy mode. The public-signup tool needs no auth and works even when `resolveAuth()` has deferred a config error.

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
| `signupgenius_get_public_signup` | `tools/public-signup.ts` | `POST SUGboxAPI.cfm?go=s.getSignupInfo` (direct `fetch`, bypasses client) | no auth | read |
| `signupgenius_list_slots` | `tools/slots.ts` | `GET /v3/signups/{id}/slots` + `s.getSignUpParticipantsBySlotItem` (direct `fetch`, bypasses client) | no auth | read |
| `signupgenius_rsvp` | `tools/rsvp.ts` | `s.PreProcessSignup` → `SUGboxAPI.cfm?go=s.getSignupInfo` → `s.processSignUpFormHandler` | session only | **write** |
| `signupgenius_claim_slot` | `tools/slot-write.ts` | `s.getSignupInfo` → `s.getSignUpFormItems` → `s.PreProcessSignup` → `s.processSignUpFormHandler` (`type:"standard"`) | session only | **write** |
| `signupgenius_release_slot` | `tools/slot-write.ts` | `GET /index.cfm?go=s.DeletePerson&id=&imid=&mid=` | session only | **write** |

### RSVP flow notes

`signupgenius_rsvp` only handles **RSVP-style** sheets (Yes/No/Maybe + optional guest counts). Under the hood it walks the same three-step browser flow the Angular wizard does:

1. `POST /index.cfm?go=s.PreProcessSignup&URLID=<urlid>` (form-encoded) — sets server-side session state. Implemented as `SignUpGeniusClient.preProcessSignUp(urlid)`.
2. `POST /SUGboxAPI.cfm?go=s.getSignupInfo` with `{ urlid }` — returns the full sign-up envelope. Used to gate on `useRSVP === 1` and pull `rsvpdetails.slotid`.
3. `POST /SUGboxAPI.cfm?go=s.processSignUpFormHandler` with the payload built by `buildRsvpPayload`.

**Slot-based sign-ups are explicitly rejected** by `signupgenius_rsvp` — they need `type:"standard"` + an `items` array + a separate `s.getSignUpFormItems` call. That path now lives in `signupgenius_claim_slot`; *reading* slots is covered by `signupgenius_list_slots`.

## Quirks

- **Deferred config (`src/index.ts` + `client.ts`).** Missing/partial creds do NOT crash the server. `resolveAuth()`'s error is stashed in `configError`; the server boots, lists tools, and only re-raises the error when a tool actually calls `SignUpGeniusClient.requireAccount()`. This is required for the host's install-time smoke test. Don't "fix" it by throwing at startup.
- **Pro-only report tools.** `report_all`/`report_filled`/`report_available` call `client.requireKeyMode(…)`, which checks the mode BEFORE `requireAccount()`. That ordering matters: plain `requireMode` re-raises the deferred `configError` first, and that error tells the user to sign into the browser — advice that can never enable a key-only endpoint. With a resolved account they throw the shared `ModeMismatchError`; with config deferred they throw `KeyModeRequiredError`, which leads with the Pro-key requirement and appends the config error. These reports are also owner-scoped, so a Pro key is not a workaround for someone else's sheet — use `signupgenius_list_slots`. They still *register* in every mode so Claude knows they exist — only the invocation fails. The v3 web API has no report equivalent (none was found during recon).
- **RSVP-only vs slot-based.** `signupgenius_rsvp` handles *only* headcount RSVP sheets (`useRSVP === 1`). It rejects non-RSVP sheets and item-based RSVPs ("Yes, I'll bring lasagna", `rsvpdetails.rsvpitems` non-empty) with actionable errors. *Writing* to slot-based "claim the 3pm slot" sheets is `signupgenius_claim_slot`; *reading* them works via `signupgenius_list_slots`.
- **`changemembermame` typo is load-bearing.** The RSVP wire payload preserves SignUpGenius's own misspelling. `RSVPITEMS` must always be emitted (as `[]` on headcount sheets) or the CFML `structKeyExists` validator throws `key [RSVPITEMS] doesn't exist`. Response `n` forces both guest counts to 0 regardless of input; `y`/`m` default to 1 adult / 0 children. See `buildRsvpPayload`.
- **Two independent session lifetimes.** The JWT (`accessToken`) and the ColdFusion session (`cfid`/`cftoken`) expire on *separate* clocks. The JWT lives 30 minutes and is renewable via `refreshToken`; the CF session lapses on its own idle timer and is only re-established by a real login or a legacy page load. Renewing the JWT does **not** revive a lapsed CF session — so `/v3/*` tools can be working while the legacy `/SUGboxAPI.cfm` tools (`legacy_get_my_signups`, `signupgenius_rsvp`) return 200 `{SUCCESS:false, MESSAGE:["…no longer logged in…"]}`. Verified live: identical cookies that worked earlier were rejected later with the browser still signed in.
- **fetchproxy is a per-login bootstrap, not a hot-path proxy.** `@fetchproxy/bootstrap` reads `accessToken`/`MTOKEN` + `cfid`/`cftoken` cookies, then closes the bridge; every subsequent call is plain Node `fetch()` with those cookies. `accessToken` and `MTOKEN` carry the same JWT (`accessToken` preferred). The lift runs on the first request AND on every detected expiry — **not** once at startup. That matters because the JWT's TTL is 30 minutes (verified by decoding `iat`/`exp` on a live token) and a fetchproxy account has empty email/password, so there is nothing to form-login with; re-reading the browser is the only renewal path. `CookieSessionManager` still replays at most once per request, so a genuinely dead browser session surfaces an `AuthError` instead of looping.
- **Re-reading cookies is not enough — the lift also renews.** An *idle* tab holds whatever the SPA last wrote, which can be a JWT that expired minutes ago (observed live: a lift returned a token 7 minutes past `exp`). `renewIfStale()` decodes `exp` and, within 120s of expiry, exchanges the token via `POST /v3/auth/refresh` with **both** `refreshToken` and `token` in the body — sending only `refreshToken` 400s with `token should not be null or undefined`. The response is `{data:{statuscode, response:{token, refreshtoken, expiresin, expires}}}` (lower-case inner keys) and rotates the refresh token. A controlled test confirmed the exchange does **not** invalidate the caller's existing session. Never log the decoded payload — the JWT carries name, email, phone, member id and IP.
- **Widening the declared cookie set forces a re-pair.** The extension gates on the scope approved at pair time, so adding `refreshToken` makes existing installs fail with `cookie keys not in declared set: refreshToken` until the user revokes `signupgenius-mcp` in the Transporter popup and re-approves.
- **Three expiry signals.** `isSessionExpired` treats a `401`, a `200` rendering the legacy HTML login page (matching `loginform`/`loginemail`/`go=c.Login`), and a `200` JSON envelope whose message contains "You are no longer logged in" as expiry → forces one re-login + replay. That third shape is what the legacy `/SUGboxAPI.cfm` dispatcher returns when the `cfid`/`cftoken` pair is missing or stale (the JWT alone does not satisfy it); it is checked without consulting `content-type`, which is not a dependable discriminator. A `403` is a Pro-permission failure, not expiry, and is left alone.
- **Two envelope shapes.** The v2/v3 JSON API returns lower-case `{data, message, success}`; the legacy `/SUGboxAPI.cfm` dispatcher returns upper-case `{DATA, MESSAGE, SUCCESS}`. `normalizeKeyShape` / `normalizeLegacyShape` reconcile them so tools always see `ApiResponse<T>`.
- **public-signup bypasses the client, and no longer scrapes HTML.** The modern `/go/` page is a pure Angular shell — no `h1.SUGHeaderText`, no slot markup, a constant `<title>Sign Me Up</title>` under any User-Agent — so the old regex scraper returned a stub for every current sheet. It now POSTs `s.getSignupInfo` via `globalThis.fetch` (injectable for tests). That call needs **no** auth, **no** `PreProcessSignup` priming and **no** prior `/go/` GET: all three orderings return byte-identical `DATA`. It carries metadata only — never slots, in either anonymous or signed-in mode.
- **`customfields` has two shape traps.** `fieldvalues` is an array for Select-style fields but an empty *string* for free-text ones, and within the array the key casing is inconsistent (the placeholder row is lower-case `optionname`/`optionval`, every real choice is upper-case). Both are handled in `toCustomFields`; both were caught by fixture-based tests, not by reading the docs.
- **Slot data comes from two unauthenticated endpoints, and you need both.** `signupgenius_list_slots` calls `GET /v3/signups/{id}/slots` with **no** headers (a bogus `Authorization` returns 500; a valid session returns a byte-identical body) for structure and counts, then `POST s.getSignUpParticipantsBySlotItem` per row for names. The v3 feed returns an empty `itemmembers` on a `hidenames` slot; the legacy call returns the names anyway, unauthenticated. Together they are the only read path for a sheet the user does not own — the Pro `report_*` endpoints are key-only *and* owner-scoped.
- **`filled_count` must come from `quantity.taken`, never from `participants.length`.** One entry can consume several spots (`myqty: 2` — a couple signing up together renders as a single name). On the reference sheet 10/24/2026 reads "4 of 6 filled" across only THREE names. `quantity.participantcount` is the distinct-people count and is legitimately lower than `taken`; both are surfaced.
- **`s.getSignUpFormItems` was a param problem, not an auth problem.** Earlier recon recorded it as unusable and left open whether a session would fix it — it would not. `siid: 0`/`""`/`[]` all mean *empty selection*; pass a real slot-item id (array, number, or numeric string) and it answers unauthenticated. It still cannot *enumerate* a sheet — it describes ids you already have, which come from the v3 slots feed. Its sibling `s.getSignUpFormAttrs` really is wizard session state and returns "none to be processed" without a live selection.
- **Release is a GET navigation, not a JSON action.** `s.DeletePerson` is reached as `GET /index.cfm?go=s.DeletePerson&id=&imid=&mid=` and answers HTML — see `SignUpGeniusClient.deletePerson()`. `s.deleteItemMember` looks like the obvious candidate but is the **owner's** admin-modal path for removing somebody else. `imid` is the `itemmemberid` from the participants endpoint.
- **A lapsed CF session shows up as a 3xx on the release path, not a 4xx.** The call uses `redirect: 'manual'`, so the dispatcher's redirect to `go=c.Login` comes back verbatim; a bare `status >= 400` check read that as a completed withdrawal. `isSessionExpired` can't help — it fires on a 401, or a **200** whose body carries the login markers, and this is neither. `deletePerson` inspects the `Location` header, and the tool re-reads the slot afterwards rather than trusting the status code.
- **`signupgenius_release_slot` resolves the member id from the session and refuses a mismatch.** `signupgenius_list_slots` publishes every participant's `item_member_id` *and* `member_id` for any public sheet, so a caller that picked the wrong row could otherwise ask us to withdraw a stranger's sign-up — and the server's authorization for `s.DeletePerson` is unverified. Note the session profile reports the id as `id`, not `memberid`.
- **`is_full` is not just `state === 'full'`.** A locked sheet still reports `state: 'available'`, and a finite row can sit at `remaining: 0` without the exact token — either would have had the tool offer a slot the server then refuses. `extractSlots` folds in both, and surfaces `locked` separately so a caller can say *why*.
- **The two slot writes are unverified end-to-end, by choice.** Their payloads were read out of the live Angular `objForm` and `d.ProcessSignUp`, but neither has been executed against the server — doing so would claim and withdraw a slot on a real sheet. Both ship behind a mandatory `confirm: true` gate that returns a dry-run preview by default. Treat the claim payload as high-confidence-but-unproven.
- **The hosted connector's name and version are set by mcp-host, not by this repo.** The claude.ai connector is registered on `mcp-host` under the slug **`signupgenius`** (`reg_769486a00e79caf8b9932ada`), which is what produces the `mcp__claude_ai_signupgenius__*` tool namespace. Local/stdio installs use `signupgenius-mcp` (the `manifest.json` / plugin name). Same server, two names — a tool list "renaming itself" mid-session is really the hosted connector and a local install swapping places, not an unstable name. `src/index.ts` passes `name: 'signupgenius'` to `runMcp`, matching the hosted slug; don't "fix" it to `signupgenius-mcp` without re-registering, or `serverInfo.name` and the slug diverge.
- **The hosted registration pins an npm version and does NOT auto-update.** It was pinned at `signupgenius-mcp@1.2.2` (with an integrity hash) while npm latest was 1.3.1 — which is why slot listing appeared "missing" from the connector even though it shipped in 1.3.0. After publishing, re-register to move the pin (`mcp-host register --slug signupgenius --npm signupgenius-mcp@<version> …`, re-passing the `--secret-env` flags), or register with `--follow` to track latest; then verify with `mcp-host list`. The runner is a scale-to-zero Fly machine, so a brief disappearance from the tool list is a cold start, not a crash.

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

<!-- pr-workflow:v3 -->
## Pull requests & release notes

Fleet policy — Conventional-Commit PR titles, labels, the auto-review /
auto-merge ladder, auto-review follow-up issues, PR timing, and release PRs —
lives in `~/.claude/CLAUDE.md`. Don't restate it here; the copies drifted.

Shared technical conventions (publishing, bundling, versioning guards,
write-verification, transport archetypes, testing traps) live in
[`chrischall/workflows`](https://github.com/chrischall/workflows):
`docs/fleet-conventions.md`, plus `README.md` for the CI pipeline contract.

## What to *not* do

- Don't reintroduce a `transport.ts` / `transport-fetchproxy.ts` layer between the client and Node fetch. The fetchproxy bootstrap is a one-shot cookie read at startup; per-request routing through the browser isn't needed here (SignUpGenius doesn't run an edge that revalidates each request, so plain Node fetch with the cookies from the bootstrap call works once you're authenticated).
- Don't paste real cookies into tests. Mock `@fetchproxy/bootstrap` at the module boundary.
- Don't break the "no env vars set" smoke-test path. The server must still start cleanly so MCP hosts can complete their install-time tool listing — `resolveAuth()` errors are deferred to tool-call time via `configError`.
