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

The river/lake GeoJSON the map renders (≈12 MB raw). Negotiates `Content-Encoding` from precompressed artifacts written at build time — **brotli (~1.8 MB)** for browsers that accept it, gzip (~3 MB) otherwise — and sets `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` with an `ETag` for cheap 304 revalidation. The Next standalone server only gzips static `public/` files, so routing this payload through an API route is what unlocks brotli and long-lived caching.

### `GET /api/gauges/history?at=<ISO>`

Historical gauge state at the given moment. `at` must be within the last 7 days. Pulls instantaneous values from USGS for every gauge with a known USGS site id, picks the observation closest to `at`, and categorizes it against the gauge's NWS thresholds. Cached per 5-minute bucket.

### `GET /api/cron/refresh-gauges`

Refresh the live gauge cache. Invalidates the `gauges` cache tag, schedules a background fetch via `after()`, and returns immediately so the caller doesn't time out (NWPS sometimes takes 60–120 s).

**Auth:** if the `CRON_SECRET` env var is set, the request must include `Authorization: Bearer <CRON_SECRET>`. Otherwise the endpoint is unauthenticated.

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
  https://your-app.example.com/api/cron/refresh-gauges
# {"ok":true,"status":"refresh scheduled"}
```

The repo ships a docker-compose sidecar (`gauge-cron`) that pings this endpoint every 30 min — see `docker-compose.yml`. Vercel Cron also works; attach `CRON_SECRET` as a project env var and Vercel will include the `Authorization` header automatically.

## How rendering works

- `scripts/build-waterways-data.mjs` produces `public/data/waterways.geojson` once at build time. For each gauge it probes NHDPlus HR for the nearest flowline (≤ 500 m) and lake polygon (≤ 250 m). If the host flowline has a `GNIS_NAME`, every reach with the same name within 40 km is pulled in. Reaches that fall inside the radius of multiple gauges are assigned to the closest gauge (nearest-vertex distance), so a gauge's color extends along the river to roughly halfway to the next gauge.
- The client (`src/components/MapView.tsx`) fetches that GeoJSON once from `/api/waterways` (brotli-compressed), mounts a single Leaflet `<GeoJSON>` layer, and pushes fresh styles via `setStyle` on each gauge tick — no remount.
- River/stream lines are hidden below zoom 8 so the state-wide view only paints lakes; the default zoom is set to that threshold so the first paint always shows rivers.

## Configuration

| Env var | Used by | Description |
| --- | --- | --- |
| `CRON_SECRET` | `/api/cron/refresh-gauges`, docker sidecar | Bearer token required on the refresh endpoint. |
| `NEXT_PUBLIC_APP_VERSION` | UI footer | Optional version label shown in the legend. |
| `CACHE_TTL_DAYS`, `OUTPUT_COORD_DP`, `NHD_CONCURRENCY`, `GAUGE_LIMIT`, `REFRESH` | `data:build` | See *Scripts*. |

## License

Data: NOAA NWPS (public domain), USGS NHDPlus HR (public domain), OpenStreetMap (ODbL).
