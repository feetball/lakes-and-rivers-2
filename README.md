# Texas Flood Map

A live map of Texas river and lake gauges, color-coded by NWS flood category. Each gauge paints the stretch of river or lake it physically sits on; adjacent gauges on the same river split coverage at roughly the midpoint between them.

Built with Next.js 15, React 19, and Leaflet (canvas renderer).

## Quick start

```bash
pnpm install
pnpm data:build      # ~1–2 min: cached geometry + one live-observations fetch
pnpm dev             # http://localhost:3000
```

Requires **pnpm 10** (pinned via `packageManager` in `package.json`; run `corepack enable` once to activate it). `pnpm data:build` reads all river/lake geometry from the committed `data-cache/gauges.tar.gz` (unpacked automatically), so the slow per-gauge NHDPlus HR probing — the old 10–20 min cold path — is skipped entirely. The remaining ~1–2 min is the single live NWPS observations download (~13 MB) plus any gauges missing from the cache. Use `pnpm data:build:refresh` to refetch all geometry from NWPS + USGS NHDPlus HR.

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Run the Next.js dev server. |
| `pnpm build` | Production build (runs `data:build --if-missing` first). |
| `pnpm start` | Run the production server (`.next/standalone`). |
| `pnpm data:build` | Build `public/data/waterways.geojson` and `gauges-meta.json`. Uses cache when present. |
| `pnpm data:build:refresh` | Same as above but ignores the cache and refetches every gauge. |
| `pnpm data:refresh-list` | Refresh the seed gauge list (`public/data/gauges-list.json`). |
| `pnpm data:cache:pack` / `:unpack` | Pack/unpack the per-gauge cache to/from `data-cache/gauges.tar.gz`. |
| `pnpm data:cache:clear` | Remove all cached per-gauge bundles. |
| `pnpm lint` | ESLint (flat config, `eslint-config-next`). |
| `pnpm typecheck` | `tsc --noEmit` across the project. |

Useful env vars for `data:build`:

- `CACHE_TTL_DAYS=N` — refetch any cache entry older than N days (default 3650; NHD geometry is static, so the committed cache is reused indefinitely. `CACHE_VERSION` busts it on schema changes).
- `OUTPUT_COORD_DP=N` — decimal places kept on output coordinates (default 5, ≈1 m).
- `NHD_CONCURRENCY=N` — parallel fetches to NHDPlus HR (default 24).
- `GAUGE_LIMIT=N` — cap gauges processed (smoke tests).
- `REFRESH=1` or `--refresh` — ignore cache.

## API endpoints

All routes live under `/api`.

### `GET /api/gauges`

Live gauge state. Returns:

```json
{
  "gauges": {
    "AUST2": {
      "id": "AUST2",
      "name": "Colorado Rv at Austin",
      "lat": 30.246, "lon": -97.694,
      "category": "no_flooding",
      "observedStage": 9.12,
      "observedAt": "2026-05-05T18:15:00Z",
      "unit": "ft",
      "thresholds": { "action": 21, "minor": 25, "moderate": 30, "major": 38 }
    }
  },
  "updatedAt": "2026-05-05T18:18:00Z"
}
```

Backed by the Next.js data cache (shared across instances on Vercel). On a cold cache, races a 4 s budget against the upstream NWPS fetch and falls back to the static gauge list (`public/data/gauges-meta.json`) if the upstream is slow.

### `GET /api/waterways`

The river/lake GeoJSON the map renders (≈12 MB raw), **as a fallback**. Negotiates `Content-Encoding` from precompressed artifacts written at build time — **brotli (~1.8 MB)** for browsers that accept it, gzip (~3 MB) otherwise — with an `ETag` (cheap 304s), browser `Cache-Control`, and `CDN-Cache-Control: s-maxage` so Vercel's edge caches it.

The client actually requests the **static** `/data/waterways.geojson` first and only falls back to this route on error. On Vercel the static asset is served straight from the edge CDN (globally cached, compressed, zero serverless cost) — the optimal path. This route exists for self-hosted standalone, whose server only gzips static files; it ships precompressed brotli (~1.8 MB vs ~3 MB gzip) for that case.

### `GET /api/gauges/history?at=<ISO>`

Historical gauge state at the given moment. `at` must be within the last 7 days. Pulls instantaneous values from USGS for every gauge with a known USGS site id, picks the observation closest to `at`, and categorizes it against the gauge's NWS thresholds. Cached per 5-minute bucket.

### `GET /api/cron/refresh-gauges`

Refresh the live gauge cache. Invalidates the `gauges` cache tag, then **awaits** the refetch within the function budget so the shared Next data cache is actually repopulated before it responds, and the caller gets a real status. The upstream fetch is bounded by `NWPS_TIMEOUT_MS` (default 45 s) so it fits Vercel's function cap.

**Auth:** if the `CRON_SECRET` env var is set, the request must include `Authorization: Bearer <CRON_SECRET>`. Otherwise the endpoint is unauthenticated.

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
  https://your-app.example.com/api/cron/refresh-gauges
# {"ok":true,"status":"refreshed","count":721}
```

The repo ships a docker-compose sidecar (`gauge-cron`) that pings this endpoint every 30 min — see `docker-compose.yml`. On Vercel, `vercel.json` registers a Cron for the same endpoint (daily, `0 6 * * *` — the Vercel Hobby plan only allows once-daily schedules; Pro can run it more often); set `CRON_SECRET` as a project env var and Vercel includes the `Authorization` header automatically. The cron is just a backstop — the gauge cache self-revalidates every 30 min on read, so freshness doesn't depend on it.

## How rendering works

- `scripts/build-waterways-data.mjs` produces `public/data/waterways.geojson` once at build time. For each gauge it probes NHDPlus HR for the nearest flowline (≤ 500 m) and lake polygon (≤ 250 m). If the host flowline has a `GNIS_NAME`, every reach with the same name within 40 km is pulled in. Reaches that fall inside the radius of multiple gauges are assigned to the closest gauge (nearest-vertex distance), so a gauge's color extends along the river to roughly halfway to the next gauge.
- The client (`src/components/MapView.tsx`) fetches that GeoJSON once — the static `/data/waterways.geojson` (edge-CDN-served on Vercel) with `/api/waterways` (brotli) as a fallback — mounts a single Leaflet `<GeoJSON>` layer, and pushes fresh styles via `setStyle` on each gauge tick — no remount.
- River/stream lines are hidden below zoom 8 so the state-wide view only paints lakes; the default zoom is set to that threshold so the first paint always shows rivers.

## Deploying to Vercel

Import the repo; the defaults work. Notes:

- **Build:** `prebuild` runs `data:build`, which unpacks the committed cache and regenerates `public/data/*` (gitignored, so they're produced fresh each deploy). The generated files ship as static assets *and* are traced into the API functions via `outputFileTracingIncludes` (`next.config.mjs`) — this is essential: the gauge routes read `gauges-meta.json` at runtime for flood thresholds, and without it on Vercel the file ENOENTs and **rivers render gray** (the symptom this addresses).
- **Data delivery:** the 12 MB waterways GeoJSON is served as a static asset from Vercel's edge CDN (compressed, globally cached, no function invocation).
- **Cache warming:** `vercel.json` registers a daily Cron on `/api/cron/refresh-gauges` (Hobby allows once-daily schedules only; bump the frequency on Pro). Set **`CRON_SECRET`** as a project env var to authenticate it (Vercel attaches the bearer token automatically). The cron is only a backstop — the live cache self-revalidates every 30 min on read, and the `/api/gauges` cold path falls back to build-time data within 4 s, so the map is never blocked on the upstream NWPS fetch.
- **Function limits:** route `maxDuration` is 60 s (Hobby cap) and the upstream fetch is bounded by `NWPS_TIMEOUT_MS` (45 s) so background warming completes within budget.
- **Admin force refresh:** set **`ADMIN_PASSWORD`** to enable an in-app **Admin** login in the legend. Once signed in, a **Force refresh data** button invalidates the shared gauge cache and pulls fresh NWPS data on demand (same effect as the cron, but session-gated via a signed HTTP-only cookie). The session is signed with `SESSION_SECRET` (falls back to `ADMIN_PASSWORD`).

## Deploying to Cloudflare

Cloudflare **Pages** can't host this app (its Next.js adapter is deprecated and was Edge-runtime-only), but Cloudflare **Workers** via the OpenNext adapter is fully wired up: `wrangler.jsonc` + `open-next.config.ts` configure the Worker (R2-backed data cache, D1-backed tag cache, a 30-min Cron Trigger), and the data routes read `public/data/*` through the assets binding instead of `fs` at runtime. Quick start: `npx wrangler login`, create the R2 bucket + D1 database, then `pnpm cf:deploy`. See [docs/deploying-to-cloudflare.md](docs/deploying-to-cloudflare.md) for the beginner-friendly step-by-step guide (account setup, secrets, custom domains, costs).

## Configuration

| Env var | Used by | Description |
| --- | --- | --- |
| `CRON_SECRET` | `/api/cron/refresh-gauges`, docker sidecar, Vercel Cron | Bearer token required on the refresh endpoint. |
| `ADMIN_PASSWORD` | `/api/admin/*` | Enables the in-app **Admin** login in the legend. Unset = admin controls are hidden. |
| `SESSION_SECRET` | `/api/admin/*` | HMAC key for signing the admin session cookie. Optional — falls back to `ADMIN_PASSWORD`; set it to rotate sessions independently of the password. |
| `NEXT_PUBLIC_APP_VERSION` | UI footer | Optional version label shown in the legend. |
| `NWPS_TIMEOUT_MS` | `/api/gauges`, `/api/cron` | Per-attempt upstream fetch timeout (default 45000). |
| `CACHE_TTL_DAYS`, `OUTPUT_COORD_DP`, `NHD_CONCURRENCY`, `GAUGE_LIMIT`, `REFRESH` | `data:build` | See *Scripts*. |

## License

Data: NOAA NWPS (public domain), USGS NHDPlus HR (public domain), OpenStreetMap (ODbL).
