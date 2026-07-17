# Deploying to Cloudflare (Workers)

## TL;DR

**This repo is already wired for Cloudflare Workers.** You don't deploy to
Cloudflare *Pages* — its Next.js adapter (`@cloudflare/next-on-pages`) is
deprecated and only ever supported the Edge runtime, which this app can't use.
The supported path for Next.js on Cloudflare is the
[OpenNext adapter](https://opennext.js.org/cloudflare) (`@opennextjs/cloudflare`)
deployed to **Workers**, and that's what this branch implements.

What's left for you is one-time account setup. The short version:

```bash
pnpm install
npx wrangler login                                  # opens a browser
npx wrangler r2 bucket create texas-flood-map-cache
npx wrangler r2 bucket create texas-flood-map-data
npx wrangler d1 create texas-flood-map-tags        # paste the printed id into wrangler.jsonc
pnpm cf:deploy                                      # builds + deploys; prints your workers.dev URL
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put CRON_SECRET
```

Each step is explained below, assuming no prior Cloudflare experience.

## Cloudflare concepts in 60 seconds

If you've only used Vercel, here's the mental mapping:

| Concept | What it is | Vercel equivalent |
| --- | --- | --- |
| **Worker** | Your app, running as a serverless function on Cloudflare's edge. One Worker serves this whole Next.js app (pages, API routes, static files). | The whole Vercel project |
| **wrangler** | Cloudflare's CLI (`npx wrangler …`). Reads `wrangler.jsonc` at the repo root — that file is to Cloudflare what `vercel.json` is to Vercel. | `vercel` CLI |
| **Binding** | A named handle your code uses to reach another Cloudflare resource (a bucket, a database, the static assets). Declared in `wrangler.jsonc`, available to code at runtime. | Environment-provided integrations |
| **R2** | Object storage (like S3). Here it backs Next's Data Cache so the cached gauge list survives across serverless instances. | Vercel's built-in Data Cache |
| **D1** | A small serverless SQLite database. Here it backs `revalidateTag()`. | Also part of Vercel's cache layer |
| **Cron Trigger** | A schedule that invokes the Worker. Replaces `vercel.json`'s `crons`. | Vercel Cron |
| **Secret** | An encrypted environment variable (`wrangler secret put NAME`). | Vercel env var |
| **workers.dev** | Free `https://<name>.<your-subdomain>.workers.dev` URL every Worker gets. | `*.vercel.app` |

## What this branch changed (already done)

You don't need to do any of this — it's context for code review and future work:

| Change | Files | Why |
| --- | --- | --- |
| Added the OpenNext adapter + wrangler | `package.json` | The build/deploy toolchain (`pnpm cf:*` scripts) |
| Worker config with R2/D1/assets bindings + a 30-min Cron Trigger | `wrangler.jsonc` | Replaces `vercel.json` on Cloudflare |
| Cache wiring: R2 for the Data Cache, D1 for tags | `open-next.config.ts` | Makes `unstable_cache`/`revalidateTag` in `src/lib/gauges-fetch.ts` work across isolates, like on Vercel |
| Custom Worker entrypoint with a `scheduled` handler | `worker.ts` | Cron Triggers invoke `scheduled()`, which self-calls `/api/cron/refresh-gauges` with the `CRON_SECRET` bearer token |
| Runtime reads of `public/data/*` now work without a filesystem | `src/lib/data-assets.ts` + the gauges/waterways routes | Workers have no `fs`; the same files ship as static assets and are read back through the `ASSETS` binding |
| `/api/waterways` serves an uncompressed body on Workers | `src/app/api/waterways/route.ts` | workerd owns response compression — hand-rolled `Content-Encoding` on a pre-compressed body gets stripped, corrupting the response. (Mostly moot: the client prefers the static `/data/waterways.geojson`, which Cloudflare's CDN compresses.) |
| Warm-up timers skipped on Workers | `src/instrumentation.ts` | No long-lived process; the Cron Trigger replaces them |
| Gauge snapshots + analytics stored in R2 instead of Vercel Blob | `src/lib/r2-data.ts`, `src/lib/gauges-store.ts`, `src/lib/analytics-store.ts` | The `DATA_BUCKET` binding replaces `BLOB_READ_WRITE_TOKEN` on Cloudflare; Blob remains a fallback for Vercel/Docker |
| Opt-in dev bindings | `next.config.mjs` | `CLOUDFLARE_DEV=1 pnpm dev` if you ever need R2/D1/ASSETS inside `next dev`; normal dev is untouched |

Vercel and Docker deploys are unaffected — every change is gated on actually
running inside the Workers runtime.

## Step-by-step setup

### 0. Prerequisites

- Node 20+ and pnpm (`corepack enable`), same as regular development.
- A Cloudflare account — free signup at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
  You do **not** need to move your domain's DNS to Cloudflare to deploy a Worker.
- `pnpm install` in the repo root (this also compiles the local Workers
  runtime used by `pnpm cf:preview`).

### 1. Log in the CLI

```bash
npx wrangler login
```

Opens a browser window; approve the request. On a headless machine, create an
API token instead (dashboard → My Profile → API Tokens → "Edit Cloudflare
Workers" template) and export it as `CLOUDFLARE_API_TOKEN`.

### 2. Create the R2 buckets (cache + app data)

```bash
npx wrangler r2 bucket create texas-flood-map-cache
npx wrangler r2 bucket create texas-flood-map-data
```

`…-cache` backs Next's Data Cache (managed by OpenNext); `…-data` holds the
app's own objects — gauge snapshots POSTed to `/api/gauges/ingest` and
analytics events (this replaces Vercel Blob on Cloudflare).

First time only: the dashboard may ask you to enable R2 for the account, which
requires a payment method on file even though usage here stays inside the free
tier (10 GB stored, ~1 M writes/month — this app stores a couple of MB).

The bucket names match what `wrangler.jsonc` already declares, so there's
nothing to edit.

### 3. Create the D1 database (revalidation tags)

```bash
npx wrangler d1 create texas-flood-map-tags
```

This prints a `database_id` (a UUID). **Paste it into `wrangler.jsonc`**,
replacing the `REPLACE_WITH_ID_FROM_wrangler_d1_create` placeholder. The
required table is created automatically during deploy. (Free tier: 5 GB, 100k
writes/day — this app writes one row per cache refresh.)

### 4. First deploy

> **⚠️ On native Windows, don't `pnpm cf:deploy` — use [Workers Builds](#deploy-on-push-like-vercels-git-integration) or WSL instead.**
> OpenNext's bundler is not reliable on Windows (it prints its own
> `not fully compatible with Windows` warning). A Windows-produced bundle
> deploys "successfully" but then throws `Dynamic require of "…middleware-manifest.json"
> is not supported` / `Wasm code generation disallowed` on **every** request,
> so the whole site 500s. The build is fine on Linux/macOS. Windows users
> should build on Linux via either **Workers Builds** (Cloudflare builds on
> their own Linux runners — recommended, see below) or **WSL**
> (`wsl --install -d Ubuntu`, then run these commands from inside Ubuntu
> under `/mnt/c/...`). The one-time resource setup above (login, R2, D1,
> secrets) works fine from native Windows — only the build/deploy step needs
> Linux.

```bash
pnpm cf:deploy
```

This runs `opennextjs-cloudflare build` (which itself runs `next build`,
including the waterways data prebuild — allow a few minutes the first time)
and then deploys. On the first deploy wrangler asks you to pick a
`workers.dev` subdomain; when it finishes it prints your live URL:

```
https://texas-flood-map.<your-subdomain>.workers.dev
```

Open it — the map should render with rivers and gauges (using build-time data
until the first cron refresh lands).

### 5. Set the secrets

```bash
npx wrangler secret put ADMIN_PASSWORD    # admin panel login
npx wrangler secret put SESSION_SECRET    # signs admin session cookies
npx wrangler secret put CRON_SECRET       # bearer token for the refresh routes
```

Each command prompts for the value and takes effect immediately (no redeploy).
`CRON_SECRET` can be any long random string (`openssl rand -hex 32`); the
scheduled handler in `worker.ts` sends it automatically, and your own external
refresher (if any) sends the same value to `/api/gauges/ingest`. You do NOT
need `BLOB_READ_WRITE_TOKEN` on Cloudflare — snapshots and analytics live in
R2 (see below).

### 6. Verify the cron

The Cron Trigger (`*/30 * * * *` in `wrangler.jsonc`) is registered at deploy
time. To watch it work: dashboard → Workers & Pages → texas-flood-map →
**Logs** (live tail), or trigger the route by hand:

```bash
curl -H "Authorization: Bearer <your CRON_SECRET>" \
  https://texas-flood-map.<your-subdomain>.workers.dev/api/cron/refresh-gauges
```

A successful refresh returns `{"ok":true,"status":"refreshed","count":…}` and
subsequent `/api/gauges` responses carry live observations. Note the upstream
NOAA fetch takes ~45 s — that's normal.

## Local preview (optional but recommended)

Run the actual Worker build in Cloudflare's real runtime (workerd) on your
machine, with local simulations of R2/D1:

```bash
cp .dev.vars.example .dev.vars   # fill in local secrets
pnpm cf:preview                  # build + serve on http://localhost:8787
```

Use this to test Workers-specific behavior before deploying. For everyday
feature work keep using `pnpm dev` — nothing about normal development changed.

## Deploy-on-push (like Vercel's git integration)

Cloudflare **Workers Builds** deploys on every push, like Vercel — and because
it builds on Cloudflare's own Linux runners, it's the **recommended path on
Windows** (see the warning under step 4).

1. Commit `wrangler.jsonc` with the real D1 `database_id` filled in (step 3) —
   CI builds from the repo, so the placeholder must be replaced and pushed.
   The id is not a secret; it's safe to commit.
2. Dashboard → Workers & Pages → texas-flood-map → Settings → **Builds** →
   connect your GitHub repo.
3. Build command: `pnpm cf:build`
4. Deploy command: `npx opennextjs-cloudflare deploy`
5. Confirm the secrets (`ADMIN_PASSWORD`, `SESSION_SECRET`, `CRON_SECRET`) are
   set on the Worker under Settings → **Variables and Secrets** — CLI-set
   secrets persist, but verify after the first CI deploy.
6. Non-production branches get preview URLs; pushes to `main` deploy prod.

On macOS/Linux you can alternatively keep deploying from your machine with
`pnpm cf:deploy`.

## Custom domain

Dashboard → Workers & Pages → texas-flood-map → Settings → **Domains &
Routes** → Add → Custom domain. If the domain's DNS is on Cloudflare it's
one click; otherwise you'll be guided to point DNS at Cloudflare first.

## Costs and limits — read this once

Workers **Free** is enough to host the map, with one real caveat:

| | Free | Paid ($5/mo) |
| --- | --- | --- |
| Requests | 100k/day | 10 M included/mo |
| **CPU time per invocation** | **10 ms** | 30 s |
| Cron Triggers | 5 schedules | 250 |
| Worker size (gzipped) | 3 MB (this app: ~1.2 MB ✓) | 10 MB |

The caveat: the cron refresh downloads and parses NOAA's ~13 MB gauge list.
Parsing that much JSON costs far more than 10 ms of CPU, so **on the free plan
the periodic live refresh will likely be killed mid-run**, and the map keeps
serving the build-time snapshot (it still works — flood categories are just as
of the last deploy). Serving cached data, the map page, and static assets are
all comfortably inside free limits.

**Recommendation:** if you want live-updating data on Cloudflare, enable
Workers Paid ($5/mo flat) — dashboard → Workers & Pages → Plans. R2 and D1
stay free-tier either way at this app's usage.

## Gauge snapshots & analytics (R2 — no Vercel Blob needed)

On Cloudflare, the two app-data stores write to the `texas-flood-map-data` R2
bucket through the `DATA_BUCKET` binding — no tokens, no third-party service:

- **Gauge snapshots** — an external refresher (e.g. the docker
  `gauge-refresher` sidecar, or any cron job you run) POSTs the NWPS list to
  `/api/gauges/ingest` with `Authorization: Bearer $CRON_SECRET`; the
  processed snapshot lands in R2 and `/api/gauges` serves it as the freshest
  source. Point an existing refresher at
  `https://texas-flood-map.<your-subdomain>.workers.dev/api/gauges/ingest`.
- **Analytics** — `/api/track` events and the admin panel's aggregates live
  under `analytics/` in the same bucket.

The Vercel Blob code paths still exist as a fallback for the Vercel/Docker
deploy targets (used only when `BLOB_READ_WRITE_TOKEN` is set and the R2
binding is absent), so the storage chain is: R2 binding → Vercel Blob token →
disabled. On Cloudflare you should NOT set `BLOB_READ_WRITE_TOKEN`.

## Troubleshooting

- **Every request 500s with `Dynamic require of "…middleware-manifest.json" is
  not supported` or `Wasm code generation disallowed` (seen in `wrangler
  tail`)** — the bundle was built on native Windows, where OpenNext's bundler
  is unreliable. The deploy succeeds but the worker is broken. Rebuild on
  Linux: use **Workers Builds** (recommended) or **WSL**. See the warning under
  step 4.
- **Deploy fails with `Invalid uuid` / `database_id` mentioning
  `REPLACE_WITH_ID...`** — you skipped step 3: create the D1 database and paste
  its id into `wrangler.jsonc` (and commit it if you deploy via Workers Builds).
- **`wrangler: command not found` / postinstall warnings** — dependencies with
  native binaries (workerd, esbuild) must be allowed to run install scripts.
  They're allowlisted in `package.json` (`pnpm.onlyBuiltDependencies`); if you
  still see "Ignored build scripts", run `pnpm rebuild esbuild workerd`.
- **Rivers/gauges render gray** — the Worker couldn't read
  `gauges-meta.json`. Check Logs for `[gauges] failed to load gauges-meta.json`;
  it ships automatically in the assets dir (`.open-next/assets/data/`), so a
  gray map usually means a stale/partial build — rerun `pnpm cf:deploy`.
- **First request after deploy shows "Loading live gauge data"** — expected:
  the shared cache is empty until the first cron tick (≤30 min) or a manual
  hit of the cron route (step 6).
- **`Request was cancelled` noise in `cf:preview` logs** — harmless; wrangler
  tries to fetch real geo metadata for the fake local request.
- **Waterways/gauge data is stale after editing data scripts** — the data is
  baked at build time; redeploy (`pnpm cf:deploy`) to rebuild it.

## Alternatives, for completeness

- **Vercel** — first-class, zero changes (README § "Deploying to Vercel").
- **Docker/VPS** — `docker-compose.yml` runs the standalone server + refresh
  sidecars; also unchanged by this migration.
- **Cloudflare as CDN only** — point Cloudflare DNS (proxied) at either of the
  above for edge caching without changing the runtime.
