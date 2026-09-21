# VPN Backend — Cloudflare Workers Edition

Same functionality as the Node version, rewritten to actually run on
Cloudflare's edge runtime (no native Node modules, no server to manage).

## Why this version is different

Cloudflare Workers don't run full Node.js — no `better-sqlite3`, no native
`bcrypt`. So this version uses:
- **D1** (Cloudflare's serverless SQLite) instead of a local file DB
- **Hono** instead of Express (built for Workers, has JWT built in)
- **Web Crypto (PBKDF2)** instead of bcrypt for password hashing
- **Plain `fetch` calls to Stripe's REST API** instead of the `stripe` npm package

Functionally it's the same: register/login, Stripe billing, proxy assignment
from your Webshare pool with per-plan limits.

## Deploying entirely from an iPhone (no computer needed)

**1. Get the code into a GitHub repo**
   - Install the GitHub app (or use github.com in Safari).
   - Create a new repo, e.g. `vpn-backend`.
   - Upload all the files in this folder, keeping the same structure
     (`src/index.js`, `src/crypto.js`, etc. — GitHub's mobile web upload
     supports drag-in of multiple files, or use the "Add file" -> "Create
     new file" option and paste contents one at a time if uploading is finicky).

**2. Create the D1 database**
   - Go to the Cloudflare dashboard (dash.cloudflare.com) in Safari.
   - Workers & Pages -> D1 -> Create database -> name it `vpn-db`.
   - Once created, open it -> Console tab -> paste the contents of
     `schema.sql` -> Run. This creates your tables.
   - Copy the Database ID shown on its overview page.

**3. Connect the repo to Cloudflare Workers**
   - Workers & Pages -> Create -> Workers -> "Import a repository" (or
     "Connect to Git") -> pick your `vpn-backend` GitHub repo.
   - Cloudflare will detect `wrangler.toml` and build settings automatically.
   - In `wrangler.toml`, replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with the
     ID you copied (edit directly in GitHub's mobile web editor, commit —
     Cloudflare will auto-redeploy on push).

**4. Bind the database and set secrets**
   - In your Worker's dashboard: Settings -> Bindings -> confirm the D1
     binding named `DB` is attached to `vpn-db` (it should pick this up from
     `wrangler.toml` automatically once deployed).
   - Settings -> Variables and Secrets -> add each of these as **encrypted**
     secrets:
     - `JWT_SECRET` (any long random string)
     - `WEBSHARE_API_KEY` (from webshare.io dashboard -> API)
     - `STRIPE_SECRET_KEY`
     - `STRIPE_WEBHOOK_SECRET`
     - `STRIPE_PRICE_ID_BASIC`
     - `STRIPE_PRICE_ID_PRO`

**5. Point Stripe's webhook at your live URL**
   - Your Worker gets a URL like `https://vpn-backend.<you>.workers.dev`.
   - In the Stripe dashboard -> Developers -> Webhooks -> Add endpoint ->
     `https://vpn-backend.<you>.workers.dev/billing/webhook`.

**6. Test it**
   - `POST https://vpn-backend.<you>.workers.dev/auth/register` with
     `{ "email": "...", "password": "..." }` — you can do this from your
     phone using an app like "HTTP Shortcuts" or "Juno" (REST client apps
     on the App Store), since there's no terminal on iOS.

## API (unchanged from the Node version)

- `POST /auth/register` / `/auth/login`
- `POST /billing/checkout` (auth) -> `{ url }` to redirect to Stripe Checkout
- `POST /billing/webhook` (Stripe calls this)
- `POST /proxy/assign` (auth + active subscription) -> proxy credentials
- `GET /proxy/mine` (auth)
- `GET /proxy/profile?assignmentId=X&ssid=YourWifiName&wifiPassword=optional` (auth) ->
  downloads an installable `.mobileconfig` file

## Using it on an iPhone

**Important limitation:** iOS only allows a personal (non-supervised) iPhone
to scope a proxy to **one specific Wi-Fi network** via an installed profile —
not a device-wide/global proxy, and not cellular data. A true always-on VPN
covering everything requires either MDM supervision (corporate-owned
devices) or a native VPN app built with Xcode using the NetworkExtension
entitlement (needs a Mac + Apple Developer account).

Flow with what's built here:
1. Client calls `POST /proxy/assign` -> gets back an `assignmentId` and proxy credentials.
2. Client opens `GET /proxy/profile?assignmentId=...&ssid=YourHomeWifi` in
   Safari (pass `wifiPassword` too if that network is secured).
3. iOS prompts to install the downloaded profile: Settings -> Profile
   Downloaded -> Install.
4. While connected to that Wi-Fi network, traffic routes through the
   assigned proxy. Connecting to a different network or switching to
   cellular bypasses it entirely — that's expected given the constraint above.

To remove it: Settings -> General -> VPN & Device Management -> tap the
profile -> Remove Profile.

## Things to revisit later

- **Proxy pool caching**: currently cached per-isolate in memory. Under real
  traffic, move this to a Cloudflare KV namespace so all edge locations
  share one cached pool instead of each hitting Webshare's API separately.
- **D1 is still relatively new** — fine for moderate traffic, but read
  Cloudflare's current D1 limits before counting on it at scale.
- Same open item as before: this hands out raw proxy credentials — your
  iOS client still needs to actually use them (e.g., via a `.mobileconfig`
  proxy profile, since a full native VPN app needs Xcode/a Mac to build).
