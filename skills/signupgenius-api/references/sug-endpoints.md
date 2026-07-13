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

Any sign-up's public page is server-rendered HTML at
`https://www.signupgenius.com/go/<urlid>-<signupid>[-<vanity>]` — no login
needed, works even without the login step above:

```sh
curl -s 'https://www.signupgenius.com/go/10C054DA9AF2BA0FEC07-63774883-myers' -o /tmp/sug-page.html

grep -oE '<h1 class="SUGHeaderText">[^<]*' /tmp/sug-page.html | sed 's/.*>//'   # title
grep -A2 '<strong>Date' /tmp/sug-page.html | head -1                           # date (needs HTML stripping)
```

There's no JSON surface for this page — `signupgenius-mcp`'s
`tools/public-signup.ts` regex-scrapes the same landmarks
(`h1.SUGHeaderText`, `<strong>Date/Time/Location</strong>`, the
`creator-info` table, and `Yes:/No:/Maybe:` response counts). Reproduce with
`grep`/`sed` for a quick look, or pull the regexes straight from that file for
anything more than a spot-check.

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

## Omitted — not reachable in session mode

Slot-report endpoints (`/signups/report/all|filled|available/{signupId}`)
require `SIGNUPGENIUS_USER_KEY` (Pro API key mode, `Authorization: <key>`
against `api.signupgenius.com/v2/k`, `user_key` in the query string) — a
different auth entirely from the session login this skill uses. No v3
equivalent was found during the MCP's recon (`src/tools/reports.ts`), so
there's nothing to transcribe for session mode. Slot-based (non-headcount)
sign-ups also have no submit flow here — the wizard's `s.getSignUpFormItems`
+ per-item payload was never captured.
