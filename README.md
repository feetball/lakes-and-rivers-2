# Texas Flood Map

A live map of Texas river and lake gauges, color-coded by NWS flood category. Each gauge paints the stretch of river or lake it physically sits on; adjacent gauges on the same river split coverage at roughly the midpoint between them.

Built with Next.js 15, React 19, and Leaflet (canvas renderer).

## Quick start

```bash
pnpm install
pnpm data:build      # one-time: ~10–20 min cold, seconds with packed cache
pnpm dev             # http://localhost:3000
```

The first build queries every Texas NWPS gauge plus the USGS NHDPlus HR service for each gauge's host waterway. A packed cache lives in `data-cache/gauges.tar.gz` and is unpacked automatically, so subsequent builds skip the network round-trip.

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
| `pnpm lint` | Next.js lint. |

Useful env vars for `data:build`:

- `CACHE_TTL_DAYS=N` — refetch any cache entry older than N days (default 30).
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
- The client (`src/components/MapView.tsx`) loads that GeoJSON once, mounts a single Leaflet `<GeoJSON>` layer, and pushes fresh styles via `setStyle` on each gauge tick — no remount.
- River/stream lines are hidden below zoom 8 so the state-wide view only paints lakes; the default zoom is set to that threshold so the first paint always shows rivers.

## Configuration

| Env var | Used by | Description |
| --- | --- | --- |
| `CRON_SECRET` | `/api/cron/refresh-gauges`, docker sidecar | Bearer token required on the refresh endpoint. |
| `NEXT_PUBLIC_APP_VERSION` | UI footer | Optional version label shown in the legend. |
| `CACHE_TTL_DAYS`, `NHD_CONCURRENCY`, `GAUGE_LIMIT`, `REFRESH` | `data:build` | See *Scripts*. |

## License

Data: NOAA NWPS (public domain), USGS NHDPlus HR (public domain), OpenStreetMap (ODbL).
