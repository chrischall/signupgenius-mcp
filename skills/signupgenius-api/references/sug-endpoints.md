# SignUpGenius session-mode endpoints for curl

All calls assume `$ACCESS_TOKEN` and `$COOKIE_HEADER` from the login step in
`../SKILL.md`. Every call sends both:

```
-H "Authorization: Bearer $ACCESS_TOKEN" -H "Cookie: $COOKIE_HEADER"
```

Paths under `api.signupgenius.com/v3` are the exact paths `signupgenius-mcp`'s
`client.ts` builds in session mode (it appends a trailing `/` to every v3
path — included below). Legacy calls POST JSON to
`https://www.signupgenius.com/SUGboxAPI.cfm?go=<action>` with
`Content-Type: application/json`.

---

## 1. Profile

```sh
curl -s 'https://api.signupgenius.com/v3/member/profile/' \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Cookie: $COOKIE_HEADER" | jq '.data'
```

## 2. Groups

List groups (`sort` is optional, `asc`/`desc`):

```sh
curl -s 'https://api.signupgenius.com/v3/groups/all/?sort=asc' \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Cookie: $COOKIE_HEADER" \
  | jq -r '.data[] | "\(.groupid)\t\(.title)"'
```

List a group's members (`GROUP_ID` from above):

```sh
curl -s "https://api.signupgenius.com/v3/groups/${GROUP_ID}/members/" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Cookie: $COOKIE_HEADER" \
  | jq -r '.data[] | "\(.communitymemberid)\t\(.emailaddress)"'
```

Get one member's detail (address/phone — only present if they supplied it on
a sign-up):

```sh
curl -s "https://api.signupgenius.com/v3/groups/${GROUP_ID}/members/${MEMBER_ID}/details/" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Cookie: $COOKIE_HEADER" | jq '.data'
```

Add a member (**write** — confirm with the user first; `firstname`/`lastname`
are optional):

```sh
curl -s -X POST "https://api.signupgenius.com/v3/groups/${GROUP_ID}/members/create/" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Cookie: $COOKIE_HEADER" \
  -H 'Content-Type: application/json' \
  -d '{"emailaddress":"new-member@example.com","firstname":"Jane","lastname":"Doe"}' \
  | jq '.success, .message'
```

## 3. Sign-up listings

In session mode `created`/`invited`/`signedupfor` each have **one** v3 path
each (unlike key mode's separate `/active`/`/expired`/`/all` paths) — filter
on `enddate` client-side if you only want active ones:

```sh
# everything the account created (active + expired together)
curl -s 'https://api.signupgenius.com/v3/signups/created/' \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Cookie: $COOKIE_HEADER" \
  | jq -r '.data[] | "\(.signupid)\t\(.enddate)\t\(.title)"'

# sign-ups invited to
curl -s 'https://api.signupgenius.com/v3/signups/invited/' \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Cookie: $COOKIE_HEADER" | jq '.data'

# sign-ups personally signed up for
curl -s 'https://api.signupgenius.com/v3/signups/signedupfor/' \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Cookie: $COOKIE_HEADER" | jq '.data'
```

Legacy dispatcher equivalent — sometimes returns fuller data than v3
(note the **upper-case** envelope):

```sh
curl -s -X POST 'https://www.signupgenius.com/SUGboxAPI.cfm?go=t.getMySignups' \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Cookie: $COOKIE_HEADER" \
  -H 'Content-Type: application/json' -d '{}' \
  | jq -r '.DATA[] | "\(.signupid)\t\(.title)"'
```

## 4. Public sign-up lookup (no auth)

Any sign-up's public page is at
`https://www.signupgenius.com/go/<urlid>-<signupid>[-<vanity>]` — no login
needed, works even without the login step above.

**The modern page is an Angular shell, not server-rendered.** Verified
2026-08-02: it contains no `h1.SUGHeaderText`, no slot markup, and a generic
`<title>Sign Me Up</title>` under any User-Agent. The only real sheet
metadata in the served HTML is the Open Graph block:

```sh
curl -s 'https://www.signupgenius.com/go/10C0849AAAA2EA4FD0-62393618-20262027' -o /tmp/sug-page.html
grep -oE '<meta property="og:(title|description)" content="[^"]*' /tmp/sug-page.html
```

Older sheets may still ship the legacy server-rendered landmarks
(`h1.SUGHeaderText`, `<strong>Date/Time/Location</strong>`, the
`creator-info` table, `Yes:/No:/Maybe:` counts); `signupgenius-mcp`'s
`tools/public-signup.ts` tries those first and falls back to `og:`. For
slots, don't scrape at all — use the JSON endpoint below.

## 5. RSVP (write, 3-step flow)

RSVP-only (Yes/No/Maybe headcount) sheets. **Confirm with the user before
running step 3** — it's the real submit. Get `URLID` (the full slug) by
parsing the public URL as in §4.

**Step 1 — PreProcessSignup** (sets a server-side session pointer; without
this every SUGboxAPI call below 404s with "none to be processed"). Expect
**301/302**, not 200:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -D - \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Cookie: $COOKIE_HEADER" \
  -H 'Content-Type: application/x-www-form-urlencoded' -H 'Accept: text/html' \
  -X POST "https://www.signupgenius.com/index.cfm?go=s.PreProcessSignup&URLID=${URLID}" \
  --data 'ScreenWidth=2000&ScreenHeight=1200'
```

**Step 2 — getSignupInfo** (fetch `useRSVP` + `rsvpdetails.slotid`; reject if
`useRSVP != 1` or `rsvpdetails.rsvpitems` is non-empty — that's an item-based
sheet, unsupported by this flow):

```sh
curl -s -X POST 'https://www.signupgenius.com/SUGboxAPI.cfm?go=s.getSignupInfo' \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Cookie: $COOKIE_HEADER" \
  -H 'Content-Type: application/json' \
  -d "{\"urlid\":\"${URLID}\"}" | tee /tmp/sug-signupinfo.json | jq '.DATA | {useRSVP, owner, id, title, slotid: .rsvpdetails.slotid}'
```

**Step 3 — processSignUpFormHandler** (the actual RSVP submit). `RSVPITEMS`
must always be present as `[]` — the CFML validator throws
`key [RSVPITEMS] doesn't exist` if it's omitted. `changemembermame` is
SignUpGenius's own typo — preserve it verbatim. `rsvpresponse` is a single
letter: `y`/`n`/`m`. A `n` response forces both guest counts to `0`
regardless of what you pass:

```sh
OWNER=$(jq -r '.DATA.owner' /tmp/sug-signupinfo.json)
LISTID=$(jq -r '.DATA.id' /tmp/sug-signupinfo.json)
TITLE=$(jq -r '.DATA.title' /tmp/sug-signupinfo.json)
SLOTID=$(jq -r '.DATA.rsvpdetails.slotid' /tmp/sug-signupinfo.json)

curl -s -X POST 'https://www.signupgenius.com/SUGboxAPI.cfm?go=s.processSignUpFormHandler' \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Cookie: $COOKIE_HEADER" \
  -H 'Content-Type: application/json' \
  -d @- <<JSON | jq '.SUCCESS, .MESSAGE'
{
  "listid": ${LISTID},
  "owner": ${OWNER},
  "urlid": "${URLID}",
  "title": "${TITLE}",
  "siid": "",
  "rsvpid": 0,
  "imid": 0,
  "usealternatename": false,
  "changemembermame": false,
  "displayfirstname": "Jane",
  "displaylastname": "Doe",
  "firstname": "Jane",
  "lastname": "Doe",
  "email": "jane@example.com",
  "optInStatus": false,
  "savecontactinfo": false,
  "rsvpresponse": "y",
  "rsvpadult": 1,
  "rsvpchildren": 0,
  "rsvpitems": [],
  "rsvpcomments": "",
  "type": "rsvp",
  "source": "main",
  "slotid": ${SLOTID},
  "isLoggedin": true,
  "payLater": false,
  "customFields": []
}
JSON
```

## Renewing an expired session token

`POST https://api.signupgenius.com/v3/auth/refresh` trades a `refreshToken`
cookie for a fresh 30-minute access token. The JWT's TTL is exactly 30
minutes (`exp - iat == 1800`).

```sh
curl -s 'https://api.signupgenius.com/v3/auth/refresh' \
  -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"${REFRESH_TOKEN}\",\"token\":\"${ACCESS_TOKEN}\"}" \
  | jq -r '.data.response.token'
```

Verified 2026-08-02. Notes:

- **Both fields are required.** Sending only `refreshToken` returns 400 with
  `{"details":"token should not be null or undefined"}`. `token` is the
  current access token — it may already be expired.
- The response nests under `data.response`, with **lower-case** keys:
  `{token, refreshtoken, expiresin, expires}`. `expiresin` is `1800`. The
  refresh token is rotated, so store the new one.
- The exchange does **not** invalidate the session you already hold — a
  controlled test confirmed the legacy dispatcher still accepted both the old
  and the new token afterwards.

### The two lifetimes (important)

The JWT and the ColdFusion session expire on **separate clocks**:

| | Cookie | Lifetime | Renewable by |
| --- | --- | --- | --- |
| v3 JSON API | `accessToken` | 30 min | `POST /v3/auth/refresh` |
| legacy `/SUGboxAPI.cfm` | `cfid` + `cftoken` | idle timeout | a real login, or loading a legacy page |

Renewing the JWT does **not** revive a lapsed ColdFusion session. So `/v3/*`
calls can succeed while every legacy `go=` action returns 200
`{"SUCCESS":false,"MESSAGE":["…You are no longer logged in…"]}` — with the
browser still visibly signed in. Treat that message as an expiry signal, not
an application error.

## Reading slots on ANY sign-up — no auth required

`GET https://api.signupgenius.com/v3/signups/{signupId}/slots` returns the
full slot grid for a public sign-up **with no Authorization header, no
cookies, and no Pro key**. This is the display feed the `/go/<slug>` page
renders from, and it is the correct way to read slot data — not the Pro
report endpoints below.

```sh
curl -s "https://api.signupgenius.com/v3/signups/${SIGNUP_ID}/slots" \
  | jq -r '.data.slots[] | .title as $t | .slotitems[]
           | "\($t)\t\(.date.starttime)\t\(.date.location.displaytext // "-")\ttaken=\(.quantity.taken)/\(.quantity.limit)\tleft=\(.quantity.remaining)"'
```

A sibling endpoint, `/v3/signups/{signupId}/dates`, returns the same
slotitems pivoted by date instead of by slot (each entry nests its parent
`slot` object). Both are unauthenticated.

Verified 2026-08-02 against sign-up `62393618`. Notes:

- **Sending a bogus `Authorization` header returns 500** — call it clean, the
  way `tools/public-signup.ts` calls `/go/`. Sending the *real* session token
  is accepted but changes nothing: the payload is byte-identical to the
  anonymous one.
- `participants.itemmembers` is `[]` and `viewer.signedupqty` is `0` even for
  a signed-in participant. On the verified sheet the slot carries
  `hidenames: true`, an owner display setting — so absent names are a sheet
  configuration, not a permission boundary. Whether a `hidenames: false` sheet
  populates `itemmembers` anonymously is **untested**.
- An unknown `signupId` returns 404 with `{"success":false,"message":[]}`.
- `signupid` comes from the `/go/` slug's middle segment, or from
  `s.getSignupInfo`'s `DATA.id`.

The `/go/<slug>` HTML is a pure Angular shell — it contains **no** slot markup
under any User-Agent — but it does carry `og:title` / `og:description` /
`og:image` meta tags with the sheet's real title and description, which is
more than `signupgenius_get_public_signup` currently extracts.

## Omitted — not reachable in session mode

Slot-report endpoints (`/signups/report/all|filled|available/{signupId}`)
require `SIGNUPGENIUS_USER_KEY` (Pro API key mode, `Authorization: <key>`
against `api.signupgenius.com/v2/k`, `user_key` in the query string) — a
different auth entirely from the session login this skill uses. No v3
equivalent was found during the MCP's recon (`src/tools/reports.ts`), so
there's nothing to transcribe for session mode.

These reports are also **owner-scoped**: they answer for sign-ups the key
holder created. For a sheet someone else owns, a Pro key is not a workaround —
use the unauthenticated `/slots` endpoint above, which carries the slot
titles, dates, locations, and taken/remaining counts that the reports were
being reached for. What `/slots` does *not* carry is per-participant identity
(who claimed which slot) or custom-question answers; those remain owner-only.

Slot-based (non-headcount) sign-ups still have no *submit* flow here — the
wizard's `s.getSignUpFormItems` + per-item payload was never captured.
`s.getSignUpFormItems` is a **form** call, not a display call: its `siid` is
the list of slot-item IDs the user has already selected, so it cannot be used
to enumerate a sheet (`siid:0` returns `SUCCESS:true` with an empty `DATA`).
It also requires `POST /index.cfm?go=s.PreProcessSignup&URLID=<slug>` first,
or the dispatcher answers "Oops! Looks like there's none to be processed".
