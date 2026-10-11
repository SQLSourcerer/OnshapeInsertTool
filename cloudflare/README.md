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
If Onshape returns an API redirect, inspect its destination before extending the
proxy; it intentionally does not follow redirects with bearer credentials.

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

Use browser DevTools Network and consistent network conditions. Compare cold and
repeat Global Library folder visits, searches, and published-part selections.
Check deferred thumbnails while scrolling, fast navigation and breadcrumbs,
configuration changes, repeated insertions into both Assembly and Part Studio,
library edits invalidating cached reads, and restoration of the final location
after rapid browsing. Measure folder display, usable insert choices, and insertion
completion separately. Reload the panel for a fresh in-memory cache.

No backend response cache is enabled, so the Worker does not conceal frontend
cache behavior. Cloudflare still serves static assets through its CDN. The free
plan has CPU and request limits; watch Worker metrics during testing. Live OAuth
and document writes must be validated against your test account after deployment.

Cloudflare references: [Static Assets](https://developers.cloudflare.com/workers/static-assets/),
[secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
[limits](https://developers.cloudflare.com/workers/platform/limits/).
Onshape reference: [Extensions](https://onshape-public.github.io/docs/app-dev/extensions/).
