# Cloudflare testing

This deployment runs the Insert Tool frontend and a stateless TypeScript backend
on one Cloudflare Worker. It retains the frontend's PHP endpoint names, but no PHP
runtime, database, or persistent disk is required. The normal PHP build remains available.

## Branch workflow

`testing/cloudflare-global-library-performance` is a child of
`feature/global-library-performance`. Keep hosting, authentication, and deployment
changes on the testing branch. Make performance fixes on the parent first, then
merge the parent into this child. Do not merge this child back into the parent.
The performance PR should use the parent branch.

## Build and deploy

Use Node.js 22 or newer for Wrangler. From the repository root:

```sh
npm ci
npm test
npm run cloudflare:check
npm run cloudflare:build
npx wrangler login
```

Choose a unique Worker name in `wrangler.jsonc`. The Cloudflare build produces
`dist-cloudflare/` with frontend assets only; it never copies `server/`, PHP,
Apache configuration, or OAuth credentials. It uses `cloudflare/app_settings.json`
instead of the ignored production settings and sets the backend URL to the page's
own origin. Keep that test app name stable so preferences remain associated with it.

Deploy the Worker to obtain its stable HTTPS `workers.dev` URL:

```sh
npm run cloudflare:deploy
```

Before OAuth credentials are configured, authenticated endpoints return 503.
Static assets can still load. Configure the credentials after creating the Onshape app:

```sh
npx wrangler secret put ONSHAPE_CLIENT_ID
npx wrangler secret put ONSHAPE_CLIENT_SECRET
```

Enter each value at the prompt. Do not put secrets in Wrangler vars, frontend
settings, or Git. The Worker does not log tokens or request URLs and returns
`Cache-Control: no-store` for authenticated responses.

## Register the Onshape test app

Create a separate OAuth app under Onshape Developer settings. Use your stable
Worker URL with a trailing slash as its redirect URL, for example
`https://onshape-inserttool-test.YOUR-SUBDOMAIN.workers.dev/`. Select the permissions
needed to read and write documents. Set the OAuth URL to the same host followed
by `/oauthsignin.php`.

Create an **Element right panel** extension for Part Studios and Assemblies.
Use this Action URL, substituting your Worker host (leave Onshape placeholders intact):

```text
https://YOUR-WORKER.workers.dev/redirect.php?documentId={$documentId}&workspaceId={$workspaceOrVersionId}&elementId={$elementId}
```

The Worker supplies the configured client ID and constructs the OAuth URL with
the exact callback parameter order expected by the frontend. Enable/subscribe to
the test app, open a scratch document, and grant access through its right-panel icon.
Individual accounts may need a test app store entry and subscription; company
admins can assign internal users through Developer settings.

`ONSHAPE_ORIGIN` defaults to `https://cad.onshape.com`. For Enterprise testing,
set it to your exact HTTPS Onshape origin. The proxy only sends bearer tokens to
that configured origin, validates the frontend's `X-Server` header, and rejects
upstream redirects. The HTML/CSS helper also only fetches from that origin.
Thumbnail GETs may follow up to three redirects within the configured HTTPS
origin, checking scheme, hostname, port, and URL credentials at every hop.
Other API redirects remain blocked; bearer credentials never follow a redirect
to another origin.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and supply test OAuth credentials:

```sh
npm run cloudflare:dev
```

Wrangler serves assets and endpoints together. Actual embedded Onshape testing
uses the deployed HTTPS URL; a local development server alone does not change
the registered extension. Rebuild/redeploy to test frontend edits.

## Validate the performance branch

The Cloudflare frontend has a **Test diagnostics** drawer at the bottom of the
panel. It automatically opens on startup failure and shows the latest 30 XHR/fetch
requests with HTTP statuses and elapsed times. OAuth errors show recognized
protocol codes such as `invalid_grant`; a status of `network failure` means no
HTTP response was received. Request timings include network and server time, not
rendering or completion of insertion. Cached frontend reads make no request and
therefore add no diagnostic entry.

Diagnostics stay in browser memory and can be cleared with **Clear diagnostics**.
They contain route categories instead of document IDs and omit query strings,
headers, tokens, request/response bodies, and arbitrary exception messages. They
are not uploaded or persisted. The normal PHP frontend does not include the drawer.

For an intermittent insertion pause, click **Start insertion trace** in the drawer,
reproduce one insertion, then click **Stop insertion trace**. The browser console
logs `[Insert trace ...]` timestamps for lookup, choice/configuration UI, metadata,
rate-limit checks, fetch/XHR, and insertion completion. A displayed choice followed
by a later UI click can explain time spent selecting a part. Fetch timing ends at
response headers; the surrounding app-method timing includes parsing and follow-up
work. These logs do not measure when Onshape finishes rendering the new instance.

In DevTools, select the Worker iframe in the console's JavaScript context dropdown.
`insertTrace.start()` and `insertTrace.stop()` also control recording. Export the
latest trace with `copy(insertTrace.report())` (Chrome/Edge DevTools), or evaluate
`insertTrace.report()` and copy its string. The trace keeps at most 300 lines in
browser memory and logs fixed method names and sanitized route categories only.
Starting a trace clears its previous history.

Use browser DevTools Network and consistent network conditions. Compare cold and
repeat Global Library folder visits, searches, and published-part selections.
Check deferred thumbnails while scrolling, fast navigation and breadcrumbs,
configuration changes, repeated insertions into both Assembly and Part Studio,
library edits invalidating cached reads, and restoration of the final location
after rapid browsing. Measure folder display, usable insert choices, and insertion
completion separately. Reload the panel for a fresh in-memory cache.

The Worker also caches selected Global Library responses across users, as described
below. Frontend cache hits still make no request; backend cache hits appear in the
drawer as `cache HIT`. Cloudflare serves static assets through its CDN. The free
plan has CPU and request limits; watch Worker metrics during testing. Live OAuth,
cache hits, and document writes must be validated against your test account after
deployment.

## Shared Global Library caching

The Worker uses Cloudflare's Cache API for the nine public library documents listed
in `app/app.ts`. A test checks that its allowlist matches the frontend. This allowlist
applies only to `https://cad.onshape.com`; Enterprise origins bypass shared caching.
No KV namespace, database, or additional secret is required.

Global Library folder contents and search indexes are JSON files stored in Blob
elements inside those documents. Successful, valid JSON Blob downloads are cached
for 15 minutes. Vendor logo thumbnails requested by one of the nine library document
IDs are cached for three hours, reusing the library allowlist without a separate
list of logo URLs. Other successful image responses are cached for three hours when
requested by thumbnail ID or document version, and five minutes for mutable
document/workspace thumbnail routes. The full API path, query string, origin, and `Accept` header form
the response key; user IDs and bearer tokens are excluded.

The Worker learns eligible CAD document IDs and exact thumbnail URLs from library
JSON. It also learns vendor thumbnails from the nine library document summaries,
but does not cache those summaries because they may contain user-specific fields.
Membership expires after 15 minutes without another qualifying library read.
Unknown thumbnails, personal libraries, ordinary folder listings, metadata,
configuration reads, and insertable lists continue to call Onshape. A browser
header cannot opt a private resource into this cache.

API requests still require a bearer header and the configured Onshape origin.
Shared cache hits bypass Onshape permission checks, so only documents intentionally
public to all app users belong in the allowlist. OAuth, insertion and other writes,
partial/conditional reads, errors, cookie-bearing responses, malformed library
JSON, and non-image thumbnail responses bypass the shared cache. Responses sent
to browsers retain `Cache-Control: no-store`. Cached responses omit the originating
user's rate-limit/cooldown headers. Cache failures fall back to normal proxying.

A successful write through this Worker to an allowlisted library clears its known
cached Blob downloads and thumbnail membership in the serving data center. Writes
made elsewhere and caches in other data centers become fresh by TTL. Already cached
vendor logos can remain stale for three hours, and other mutable thumbnails for
five minutes. The existing frontend cache
can retain Global Library reads for three hours within an open panel.

Cache API contents are local to each Cloudflare data center and may be evicted.
Simultaneous cold requests can still make separate upstream calls. Concurrent
membership-index updates can lose discoveries and cause extra cache misses; they
cannot add resources outside the public library data. These limits affect savings,
not insertion behavior.

To validate, open the same Global Library folder under two users or reload the
panel to clear its in-memory cache. The first backend read should show `cache MISS`
and a repeat should show `cache HIT`, with no new Onshape request on the hit.
`cache BYPASS` means the response was not served or stored by the shared cache.
Inspect `X-Global-Library-Cache` in Network or use the test diagnostics drawer.
Verify actual hits on the deployed host; local unit tests do not establish CDN
availability, eviction behavior, or production savings.

Cloudflare reference: [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/).

For thumbnail redirect failures, the testing Worker logs `[Thumbnail redirect]`
with the upstream status and destination hostname and path. Query strings,
fragments, URL credentials, and path segments of 24 or more characters are omitted
or redacted. Missing or invalid destinations are logged as `null`. The `followed`
field distinguishes accepted thumbnail fallbacks from blocked redirects.
Use `npx wrangler tail --format=json` while reopening the affected
library to capture these temporary diagnostics; a browser HAR cannot show the
upstream redirect destination.

Cloudflare references: [Static Assets](https://developers.cloudflare.com/workers/static-assets/),
[secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
[limits](https://developers.cloudflare.com/workers/platform/limits/).
Onshape reference: [Extensions](https://onshape-public.github.io/docs/app-dev/extensions/).
