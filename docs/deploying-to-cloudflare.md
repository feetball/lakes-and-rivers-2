# Deploying to Cloudflare

## TL;DR

**Don't target Cloudflare Pages — target Cloudflare Workers.** Cloudflare's
Next.js adapter for Pages (`@cloudflare/next-on-pages`) is deprecated, and it
required every route to run on the Edge runtime anyway, which this app can't
do (several routes declare `export const runtime = 'nodejs'` and read files
with `fs`). Cloudflare's officially recommended path for Next.js is now the
[OpenNext Cloudflare adapter](https://opennext.js.org/cloudflare)
(`@opennextjs/cloudflare`) deployed to **Workers**, which supports the Node.js
runtime via `nodejs_compat`. Workers has the same free tier, custom domains,
and git-driven deploys (via Workers Builds) that Pages has.

That said, this app is fairly Vercel-shaped, so a Cloudflare deploy is a small
migration, not just a config change. The sections below cover what has to
change and the step-by-step setup.

## Why this app doesn't fit Cloudflare Pages

| App feature | Where | Problem on Pages |
| --- | --- | --- |
| `runtime = 'nodejs'` API routes | `src/app/api/admin/*`, `/api/track` | `next-on-pages` (deprecated) only supported the Edge runtime |
| Runtime `fs.readFile` of `public/data/*` | `/api/waterways`, `/api/gauges/*` (`src/lib/gauges-fetch.ts`) | No filesystem on the Pages/Workers runtime |
| `output: 'standalone'` + `postbuild` copy | `next.config.mjs`, `package.json` | Assumes a long-lived Node server |
| Vercel Cron | `vercel.json` | Pages has no cron; Workers does (Cron Triggers) |
| `@vercel/blob` snapshot store | `src/lib/gauges-store.ts`, `src/lib/analytics-store.ts` | Works anywhere via HTTP with `BLOB_READ_WRITE_TOKEN`, but R2 is the native fit |
| `instrumentation.ts` warm-up `setInterval` | `src/instrumentation.ts` | Workers forbid timers/IO at global scope; there is no long-lived process |
| `unstable_cache` + `revalidateTag` | `src/lib/gauges-fetch.ts`, refresh routes | Needs OpenNext cache bindings (R2 incremental cache + D1/DO tag cache) to work across isolates |

## Deploying to Cloudflare Workers (OpenNext)

### 1. Install the adapter

```bash
pnpm add @opennextjs/cloudflare
pnpm add -D wrangler
```

### 2. Add `wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "texas-flood-map",
  "main": ".open-next/worker.js",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  // Required by OpenNext for ISR/data-cache revalidation self-calls.
  "services": [
    { "binding": "WORKER_SELF_REFERENCE", "service": "texas-flood-map" }
  ],
  // Backs the Next Data Cache (unstable_cache in src/lib/gauges-fetch.ts).
  "r2_buckets": [
    { "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "texas-flood-map-cache" }
  ],
  // Backs revalidateTag() (cron + admin refresh routes).
  "d1_databases": [
    { "binding": "NEXT_TAG_CACHE_D1", "database_name": "texas-flood-map-tags", "database_id": "<create with: wrangler d1 create texas-flood-map-tags>" }
  ]
}
```

Create the resources first:

```bash
npx wrangler r2 bucket create texas-flood-map-cache
npx wrangler d1 create texas-flood-map-tags   # paste the returned id into wrangler.jsonc
```

### 3. Add `open-next.config.ts`

```ts
import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';
import d1NextTagCache from '@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache';

export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  tagCache: d1NextTagCache,
});
```

### 4. Code changes required

These are the parts of the app that assume a Node server or Vercel and need
adjusting before the Worker will run correctly:

1. **Runtime `fs` reads of `public/data/*`.** `/api/waterways`,
   `/api/gauges/*`, and `src/lib/gauges-fetch.ts` read
   `public/data/gauges-meta.json` and `public/data/waterways.geojson.*` from
   disk via `process.cwd()`. There is no filesystem in the Worker. Since these
   files already ship as static assets, the drop-in replacement is to fetch
   them through the assets binding instead:

   ```ts
   import { getCloudflareContext } from '@opennextjs/cloudflare';
   const { env } = getCloudflareContext();
   const res = await env.ASSETS.fetch(new URL('/data/gauges-meta.json', request.url));
   const meta = await res.json();
   ```

   The `/api/waterways` brotli-negotiation route can simply be skipped on
   Cloudflare — the client already prefers the static
   `/data/waterways.geojson`, and Cloudflare's CDN serves static assets
   compressed, which is the same "optimal path" the README describes for
   Vercel.

2. **`next.config.mjs`.** Remove `output: 'standalone'` (the adapter manages
   its own output) and drop the `postbuild` script for this target. Also call
   `initOpenNextCloudflareForDev()` in the config so `next dev` can access
   bindings locally (see the OpenNext docs).

3. **`instrumentation.ts`.** The warm-up `setTimeout`/`setInterval` and the
   daily gauge-list refresh cannot run in a Worker (no global timers, no
   writable `public/`). Gate the whole `register()` body behind the same kind
   of check used for Vercel — e.g. skip when `process.env.CLOUDFLARE === '1'`
   (set it as a Worker env var) or just set `DISABLE_GAUGE_LIST_REFRESH=1`
   and guard the timers. The cron trigger (below) replaces the warming.

4. **Blob storage.** `@vercel/blob` keeps working from a Worker if you set
   `BLOB_READ_WRITE_TOKEN` (it's a plain HTTPS API), so this can be deferred.
   The native migration is to swap `src/lib/gauges-store.ts` and
   `src/lib/analytics-store.ts` to an R2 binding (`env.BUCKET.put/get`) —
   they're already isolated behind small read/write helpers, so it's a
   contained change.

### 5. Environment variables & secrets

Set for the Worker (dashboard → Worker → Settings → Variables, or CLI):

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put CRON_SECRET
npx wrangler secret put BLOB_READ_WRITE_TOKEN   # only if staying on Vercel Blob
```

For local preview, put the same keys in a `.dev.vars` file (gitignored).

### 6. Build, preview, deploy

```bash
npx opennextjs-cloudflare build     # runs `next build` (incl. prebuild data step), transforms output
npx opennextjs-cloudflare preview   # run locally in the real workerd runtime — test /api/gauges here
npx opennextjs-cloudflare deploy
```

Wire these into `package.json` as `preview`/`deploy` scripts, and/or connect
the repo to **Workers Builds** in the Cloudflare dashboard for deploy-on-push
(build command: `npx opennextjs-cloudflare build`, deploy command:
`npx opennextjs-cloudflare deploy`).

### 7. Replace the Vercel Cron

`vercel.json`'s cron won't run on Cloudflare. Add a Cron Trigger:

```jsonc
// wrangler.jsonc
"triggers": { "crons": ["0 6 * * *"] }
```

The OpenNext worker only serves HTTP, so the simplest wiring is a tiny
custom entrypoint that re-exports the OpenNext worker and adds a `scheduled`
handler which self-fetches the refresh route with the bearer token Vercel
used to attach automatically:

```ts
// worker.ts (set "main" to this file's build output per OpenNext's custom-worker docs)
import worker from './.open-next/worker.js';

export default {
  fetch: worker.fetch,
  async scheduled(_event, env) {
    await env.WORKER_SELF_REFERENCE.fetch('https://self/api/cron/refresh-gauges', {
      headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
    });
  },
} satisfies ExportedHandler<CloudflareEnv>;
```

Note: unlike Vercel Hobby, Workers cron has no once-daily restriction — you
can match the docker sidecar's 30-minute cadence (`*/30 * * * *`) for free.

## Alternative: keep it simpler

If the goal is just "host this somewhere", note that the repo already has two
zero-surprise deploy targets that need no code changes:

- **Vercel** — first-class (see `README.md` § "Deploying to Vercel");
- **Docker** — `docker-compose.yml` runs the standalone server plus the
  `gauge-cron`/`gauge-refresher` sidecars on any VPS.

A middle path is Cloudflare-as-CDN in front of either of those (free plan,
just DNS + proxy), which gets you Cloudflare's edge caching for the static
waterways GeoJSON without migrating the runtime.
