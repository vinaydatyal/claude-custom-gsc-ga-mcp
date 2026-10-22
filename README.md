# Search Console + Analytics MCP

Your own remote MCP server for Google Search Console **and** Google Analytics 4,
over a single Google sign-in. It is also its own OAuth 2.1 authorization server,
which is what claude.ai requires before it will accept a custom connector, and
it delegates the actual sign-in to Google.

Zero dependencies — Node 20+ built-ins only. No `node_modules`, no database.

```
claude.ai  ──OAuth──▶  this server  ──OAuth──▶  Google
    │                       │
    │                       ├──────────────▶  Search Console API
    └────────MCP───────────▶└──────────────▶  Analytics Data + Admin API
```

Both products run through one connector deliberately. Search Console knows how
people found a page; GA4 knows what they did next. Keeping them on one
connection is what lets a single question — "clicks held up, so why are signups
down?" — be answered without jumping between two tools.

---

## 1. Create the Google OAuth client

You need a Google Cloud project with the Search Console API enabled and an OAuth
client. About five minutes, once.

1. Go to <https://console.cloud.google.com/projectcreate> and create a project
   (name it anything — `gsc-mcp` is fine).
2. Enable the APIs this server uses:
   - <https://console.cloud.google.com/apis/library/searchconsole.googleapis.com>
   - <https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com>
     (GA4 reporting)
   - <https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com>
     (GA4 property discovery)

   Skip the last two if you set `GA4_ENABLED=false`. If a call later fails with
   "API has not been used in project … before or is disabled", enable whatever
   service that error names — Google has shuffled these entries around and the
   older `webmasters` alias still exists in some projects. The error always
   says which one it wants.
3. Configure the consent screen at **APIs & Services → OAuth consent screen**:
   - User type **External** (unless you have a Workspace org, in which case
     **Internal** is simpler and skips the rest of this step)
   - Fill in app name, your email, developer email
   - Under **Audience**, leave the app in **Testing** and add your own Google
     account as a test user. A testing app is capped at 100 users and its
     refresh tokens expire after 7 days — fine while you try it, but see
     [Publishing status](#refresh-tokens-expiring-after-7-days) below before you
     rely on it.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application** ← not "Desktop app". The sign-in
     happens in a browser and comes back to your server, so Google needs the
     web flow even though only you will use it.
   - **Authorized redirect URI**: `https://YOUR-DOMAIN/oauth/google/callback`
   - Copy the client ID and client secret.

Scopes are requested automatically: `openid`, `email`,
`webmasters.readonly` (or `webmasters` if you turn on write mode), and
`analytics.readonly` unless GA4 is disabled. One `analytics.readonly` scope
covers both GA4 reporting and property discovery, and GA4 is read-only here
regardless of what `GSC_ENABLE_WRITE` is set to.

---

## 2. Configure

```bash
cp .env.example .env
npm run secret      # paste the output into SERVER_SECRET
```

Four values are required:

| Variable | What it is |
|---|---|
| `BASE_URL` | The public https origin, no trailing slash. This is the OAuth issuer, so it must match what the outside world sees exactly. |
| `SERVER_SECRET` | Signs and encrypts every token the server issues. 32+ bytes. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From step 1. |
| `ALLOWED_EMAILS` | Comma-separated Google accounts permitted to connect. |

`ALLOWED_EMAILS` is not optional in spirit. The server is on the public internet
and accepts dynamic client registration from anyone, by design — that is how
Claude connects without you pre-registering anything. The email allowlist is
what stops a stranger who finds the URL from attaching it to *their* Claude
account and reading your data. The server refuses to start without it.

Everything else has a working default; see `.env.example`.

---

## 3. Deploy

The server listens on `PORT` (default 8080) and needs to be reachable over
HTTPS. Anything that runs a Node process works.

**Fly.io** — `fly.toml` is included:

```bash
fly launch --no-deploy
fly secrets set SERVER_SECRET=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
               ALLOWED_EMAILS=you@gmail.com BASE_URL=https://your-app.fly.dev
fly volumes create gsc_data --size 1   # optional, see State below
fly deploy
```

**Railway / Render** — point at the repo, set the env vars, start command
`node server.js`. Set `BASE_URL` to the URL the platform gives you.

**Docker** anywhere:

```bash
docker build -t gsc-mcp .
docker run -p 8080:8080 --env-file .env gsc-mcp
```

**A VPS behind Caddy** — `node server.js` under systemd, with:

```
gsc.example.com {
    reverse_proxy localhost:8080
}
```

Then set the redirect URI from step 1 to `https://YOUR-DOMAIN/oauth/google/callback`
if you had not already, and open `https://YOUR-DOMAIN/` — it shows the connector
URL and the tools it is serving.

> `BASE_URL` must use `https://`. The server refuses to start otherwise, except
> on localhost. OAuth over plain HTTP would expose every token in transit.

---

## 4. Connect it to Claude

**claude.ai (web, desktop, mobile)** — Settings → Connectors → **Add custom
connector**. Enter:

```
https://YOUR-DOMAIN/mcp
```

Leave the OAuth client ID and secret blank; the server registers Claude
automatically. You will be sent to Google to sign in, and then straight back.

Enable the connector per conversation from the **+** menu beside the message
box.

**Claude Code**:

```bash
claude mcp add --transport http gsc https://YOUR-DOMAIN/mcp
```

It opens the same sign-in in your browser and returns to a loopback port. Claude
Code gets an extra confirmation screen before the redirect, because a local port
is something any program on the machine could be listening on.

---

## Tools

**Search Console** — how people found the site in Google Search:

| Tool | What it answers |
|---|---|
| `list_properties` | Which properties this account can see, and at what permission level |
| `search_analytics` | Clicks, impressions, CTR and position for one period, broken down by query, page, country, device, search appearance, date or hour |
| `compare_periods` | What changed between two periods, totals plus per-row deltas |
| `top_movers` | The queries or pages that gained or lost the most — the traffic-drop investigation tool |
| `inspect_url` | Index status, canonical, last crawl, mobile usability and rich results for one URL |
| `list_sitemaps` / `get_sitemap` | Submitted sitemaps, with URL counts and errors |
| `submit_sitemap` / `delete_sitemap` | Only when `GSC_ENABLE_WRITE=true` |

**Analytics 4** — what they did once they arrived:

| Tool | What it answers |
|---|---|
| `ga4_list_properties` | Every GA4 property the account can see, with its numeric ID |
| `ga4_run_report` | Any combination of GA4 dimensions and metrics over a date range, with filters and sorting |
| `ga4_compare_periods` | Two periods side by side, with per-row deltas and percentage change |
| `ga4_realtime_report` | Active users in the last 30 minutes, by page, country, device or source |
| `ga4_metadata` | Which dimension and metric names this property accepts, custom definitions included |

A few things they do that the raw APIs do not:

- **Bare domains resolve.** Ask for `example.com` and it finds
  `sc-domain:example.com` among your properties. A name that matches nothing
  comes back as an error listing what you do have, rather than an empty result
  set that looks like zero traffic.
- **Relative dates.** `28daysAgo`, `3monthsAgo`, `yesterday` alongside
  `YYYY-MM-DD`, so the model never has to know today's date to ask for last
  month.
- **Totals come with breakdowns.** Search Console will not return both in one
  call, so `search_analytics` makes the second call for you. Worth knowing:
  query-level clicks never sum to the site total, because Google drops queries
  made by very few people. Compare totals to totals.
- **Rows that vanished are still reported.** In a comparison, a query that had
  traffic last month and none this month is the most interesting row there is,
  so it comes back flagged `isLost` rather than silently dropping out.
- **Position deltas are explained.** Position 1 beats position 10, so a negative
  `positionDelta` is an improvement. Every response that includes one says so,
  because models reliably get this backwards otherwise.
- **GA4 rows arrive readable.** The Data API returns dimension and metric values
  in parallel positional arrays with the names only in the headers, and every
  number as a string. These tools flatten that into named, numeric rows.
- **GA4 properties resolve by name.** You know the property as "Example Shop",
  not as `properties/987654321`. A name matching more than one property is an
  error listing the candidates, never a guess — reporting on the wrong property
  silently is worse than failing.
- **Field names are discoverable.** GA4 renamed `conversions` to `keyEvents`,
  and every property has its own custom dimensions. When the API rejects a
  field, the error points at `ga4_metadata`, which lists what that specific
  property accepts.

### Joining the two

Search Console reports a **full URL** in its `page` dimension; GA4 reports a
**path** in `landingPage`. To line them up, compare paths rather than whole
URLs. The pairing worth knowing: a page whose clicks and position held steady
while its GA4 conversions fell is a landing-page problem, not a ranking one —
and the reverse, impressions up but sessions flat, usually means the ranking
gain landed on a query that does not convert.

---

## How the auth works

Worth understanding if you ever have to debug it.

1. Claude fetches `/.well-known/oauth-protected-resource`, which names this
   server as its own authorization server, and
   `/.well-known/oauth-authorization-server` for the endpoints.
2. Claude registers itself at `/register` (RFC 7591). Instead of a client table,
   the registered metadata is sealed into the `client_id` itself, so
   registration costs nothing and survives restarts.
3. Claude sends the user to `/authorize` with PKCE. The server validates the
   redirect target twice — against what that client registered, *and* against a
   server-wide policy that only permits the Claude callbacks and loopback. The
   second check is what stops an open redirect, since anyone can register.
4. The user signs in at Google. On the way back, the server checks the email
   against `ALLOWED_EMAILS` and mints a 60-second authorization code.
5. `/token` verifies PKCE, marks the code spent, and issues an access token and
   a refresh token. Both are AES-256-GCM sealed blobs carrying the Google
   refresh token inside them, keyed separately per purpose — so an access token
   cannot be replayed as a refresh token, or either as an authorization code.
6. Every MCP call unseals the bearer token, trades the Google refresh token for
   an access token (cached in memory for the hour it lives), and calls the API.

Refresh tokens rotate on every use, as OAuth 2.1 requires for public clients.

### State

The server keeps essentially nothing. The only server-side state is a list of
spent authorization codes and rotated-out refresh tokens, both expiring. In
memory that is fine: after a restart the worst case is that a refresh token
which had already been rotated out keeps working until it expires on its own.
Set `STATE_DIR` to a writable path to persist it.

Nothing else is stored. No database, no session table, no Google tokens at
rest — the Google refresh token only ever exists encrypted inside a token held
by Claude.

---

## Tests

```bash
npm test
```

119 checks against a stub that impersonates Google: the full connector
lifecycle, plus the cases that matter — authorization code replay, PKCE
mismatch, open-redirect attempts, non-allowlisted accounts, refresh rotation,
and token type confusion. On the GA4 side it asserts the request bodies the
server builds, not just the responses it parses: filter trees, string-typed
limits, and two date ranges in one call. No network access needed.

---

## Troubleshooting

**"Couldn't reach the MCP server"** — Claude never found the discovery
documents. Check that `https://YOUR-DOMAIN/.well-known/oauth-protected-resource`
returns JSON from the public internet, and that its `resource` field is exactly
the URL you typed into Claude, trailing slash and all. A WAF or Cloudflare
rule that blocks `/.well-known/*` will do this too; Anthropic's requests come
from `160.79.104.0/21`.

**"Authorization with the MCP server failed"** — usually the Google redirect URI.
It must be `https://YOUR-DOMAIN/oauth/google/callback` exactly, in the same
OAuth client whose ID you configured. Set `LOG_LEVEL=debug` and watch the logs
through a connect attempt; every rejection is logged with a reason.

**"This Google account is not permitted"** — the email Google returned is not in
`ALLOWED_EMAILS`. The rejection is logged with the address it saw.

**"Google did not return a refresh token"** — Google only re-issues one on
explicit consent. Remove the app at
<https://myaccount.google.com/permissions> and connect again.

### Refresh tokens expiring after 7 days

A Google OAuth app left in **Testing** has its refresh tokens expire after seven
days, which shows up as the connector going dead once a week. Two fixes:

- Set the consent screen to **In production**. For scopes Google considers
  sensitive — which `webmasters` is — this normally prompts verification, but an
  app with no other users can be published and used while unverified; you will
  see an "unverified app" interstitial on sign-in that you click through once.
- Or use an **Internal** app, if the Google account is in a Workspace
  organisation. Internal apps have no such expiry and need no verification.

**403 from the API** — either the Google account genuinely lacks access to that
property, or the relevant API is not enabled in the Cloud project. The error
text distinguishes them, and when it is the latter it names the exact service
to enable.

**"The Google sign-in behind this connection does not cover this API"** — the
stored Google grant predates a scope the server now needs, which happens if you
turn on `GA4_ENABLED` or `GSC_ENABLE_WRITE` after connecting. Disconnect the
connector in Claude and connect it again; the sign-in re-consents to the full
current scope set.

**A GA4 field name is rejected** — call `ga4_metadata` with a `search` term.
`conversions` is now `keyEvents`, and custom dimensions are named per property
(`customUser:plan_tier` and the like).

---

## Security notes

- The email allowlist is the access control. Treat it as such.
- `SERVER_SECRET` is the key to every token the server has ever issued. Rotating
  it invalidates all connections — harmless, you reconnect once.
- Write mode is off by default. With it off, the server holds only the
  `webmasters.readonly` Google scope, so even a total compromise cannot change
  anything in Search Console. GA4 is read-only unconditionally — there is no
  setting that grants this server write access to Analytics.
- `GA4_ENABLED=false` removes the Analytics scope from the sign-in entirely,
  rather than merely hiding the tools.
- `/register`, `/authorize` and `/token` are rate limited per IP.
- The server never logs a token, a code, or a client secret.
