# texas-flood-map-tiles

A small Cloudflare Worker that serves the app's basemap: one
[Protomaps](https://docs.protomaps.com/) PMTiles archive of Texas, stored in R2.
It replaces OpenStreetMap's public tile servers, whose usage policy has no
exception for distributed apps (or for safety apps) and which can block with no
notice and no SLA. The map data is still OpenStreetMap's (ODbL); only the
hosting is ours.

```
phone / browser ──▶ tiles.<your-domain> (this Worker) ──▶ R2: texas.pmtiles (~1.5 GB)
                       edge cache, CORS allowlist
```

## Why a separate Worker (not part of the main one)

- **The main Worker is OpenNext (the whole Next app).** Tile traffic is by far its
  largest request volume; it shouldn't share an isolate, a deploy, or an outage
  with the API and the website.
- **Different change cadence.** This code is ~150 lines and rarely changes; the
  main Worker redeploys on every push to `main` (and sometimes fails to build).
  The basemap shouldn't go down because a gauge-page commit broke a build.
- **The URL is baked into every installed app.** Serving tiles from a hostname of
  your own (`tiles.<domain>`) lets you change what's behind it, a new archive, a
  CDN, even another provider, without shipping an app update.

It lives in this repo (so the app and the tile format stay in step) but is its own
project with its own `package.json`, `wrangler.jsonc` and deploy. The root
`tsconfig.json` and ESLint config skip it, and the main Worker's build never
touches it.

## Endpoints

| Path | Returns |
|---|---|
| `/{name}/{z}/{x}/{y}.mvt` | Vector tile from `{name}.pmtiles`, gzip, as stored. `204` for a valid coordinate with no data. |
| `/{name}.json` | TileJSON (bounds, zoom range, attribution), handy as a health check. |

Browser requests must come from an origin in `ALLOWED_ORIGINS` (`wrangler.jsonc`),
otherwise `403`. The iOS app's web view is `capacitor://localhost`, Android's is
`https://localhost`. **Add the production website origin there.** Requests with no
`Origin` header (curl, native code) are allowed; the check keeps casual hotlinking
from other websites off your bill, it isn't authentication.

## First-time setup

You need `pmtiles` ([releases](https://github.com/protomaps/go-pmtiles/releases)
or `brew install pmtiles`) and ~2 GB free disk for the extract.

```bash
cd tiles-worker && pnpm install
npx wrangler login
npx wrangler r2 bucket create texas-flood-map-tiles

# 1. Cut Texas (z0-15, ~1.5 GB) out of the Protomaps daily build.
scripts/extract.sh                      # MAXZOOM=14 for ~670 MB

# 2. Upload it. Create an R2 API token first: dashboard -> R2 -> Manage API
#    tokens -> Object Read & Write on the tiles bucket.
export R2_ACCOUNT_ID=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
scripts/upload.sh

# 3. Deploy the Worker.
pnpm deploy
curl -s https://texas-flood-map-tiles.<your-subdomain>.workers.dev/texas.json | head -c 300
```

## Custom domain (needed before the store build)

`*.workers.dev` serves tiles fine (the edge cache works there too: a repeat request
returns `cf-cache-status: HIT`, measured on this deployment), but the hostname gets
compiled into every installed app. Use a name you control so you can change what's
behind it later. The domain's DNS must be on Cloudflare. In `wrangler.jsonc` uncomment
`"routes": [{ "pattern": "tiles.example.com", "custom_domain": true }]` with your
hostname and `pnpm deploy`. Check caching by requesting a tile twice (the first
response has no `cf-cache-status`, repeats say `HIT`):

```bash
curl -sI -H 'Accept-Encoding: gzip' https://tiles.example.com/texas/10/233/421.mvt | grep -i cf-cache-status
```

## Pointing the app at it

Build the web/mobile app with the tile template (note `{z}/{x}/{y}` stay literal):

```bash
NEXT_PUBLIC_VECTOR_TILE_URL='https://tiles.example.com/texas/{z}/{x}/{y}.mvt' pnpm mobile:build
```

With it unset the app keeps using OpenStreetMap's raster tiles (fine for the
low-traffic website, not for the store apps). See `src/components/Basemap.tsx`.

The app asks the archive for its highest stored zoom (`/texas.json`, `maxzoom`) and
overzooms past it, so the archive can be cut at z14 (~670 MB) or z15 (~1.5 GB) and
re-cut later without an app update. Don't make the app assume a zoom the archive
lacks: the tiles come back empty and the map goes blank at high zoom.

## Updating the basemap

Re-run `scripts/extract.sh` and `scripts/upload.sh`; uploading over `texas.pmtiles`
replaces it in place and the Worker picks up the new ETag on its next read. Tiles
carry `Cache-Control: max-age=604800`, so phones and the edge may show the old map
for up to a week. Roads change slowly; once or twice a year is plenty.

## Costs

The 1.5 GB archive fits inside R2's free tier (10 GB storage, 10 M reads/month).
The Worker needs the Workers **Paid** plan ($5/month, shared with the account's
other Workers) once traffic passes the free plan's 100 k requests/day; one map view
is on the order of 10-30 tile requests, and the edge cache absorbs repeats.

## Development

```bash
pnpm typecheck      # regenerates worker types, then tsc
pnpm test           # routing + CORS unit tests (node --test)
pnpm dev            # wrangler dev; load a small slice into local R2 first:
BBOX=-97.80,30.22,-97.65,30.33 OUT=data/austin.pmtiles scripts/extract.sh
npx wrangler r2 object put texas-flood-map-tiles/austin.pmtiles --file=data/austin.pmtiles --local
curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/austin/15/7487/13490.mvt
```

Gotcha worth knowing: tile bodies are already gzip, so the Worker forwards them with
`Content-Encoding: gzip` and `encodeBody: 'manual'`, and keeps the encoding header off
the Cache API's copy (see `withHeaders` in `src/index.ts`). Without both, tiles are
gzipped twice and the map renders blank.
