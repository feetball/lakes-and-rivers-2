# texas-flood-map-tiles

The basemap server for the Texas Flood Map website and mobile apps: a small
Cloudflare Worker that serves one [Protomaps](https://docs.protomaps.com/) PMTiles
archive of Texas out of R2. It replaces OpenStreetMap's public tile servers, whose
usage policy does not allow a distributed app, has no exception for safety apps,
and promises no uptime. The map data is still OpenStreetMap's (ODbL); only the
hosting is ours.

```
website / iOS / Android ──▶ https://tiles.kuecker.us (this Worker) ──▶ R2: texas.pmtiles
   (OSM raster layer as the                  edge cache, origin allowlist
    automatic fallback)
```

**Every build of the app uses it by default** (`NEXT_PUBLIC_VECTOR_TILE_URL` in
`src/lib/api.ts`), and switches to the raster layer (OpenStreetMap) by itself while this
server is unreachable or failing, then back once it recovers. How, in short
(`src/components/Basemap.tsx`, `src/lib/vectorTiles.ts`):

- **Give up** (switch to the raster layer) immediately when the TileJSON cannot be read
  (unreachable, HTTP error, an HTML portal page, or no answer in 4 s) or the renderer's
  code fails to load. When 4 tile requests in a row fail (HTTP error, network or CORS
  error, no answer within 15 s, or a 200 whose body is not a vector tile, such as a
  double-compressed tile or a portal page), it first waits 1.5 s and probes the tile
  server again; it only switches if that also fails **and** the raster layer is
  reachable, so one connection blip, one bad tile, or a dead internet connection does
  not wipe a map that is still drawn. Requests the map cancels itself on every zoom
  change are not failures, and neither is being offline (a cold start offline keeps the
  vector layer and its cached tiles).
- **Come back** with no blank flash: a probe (one random mid-zoom tile, straight to the
  server) is tried after 1 minute; when it succeeds the vector layer is mounted on top
  of the raster one, which is only removed once the vector tiles are drawn. A failed
  attempt doubles the wait (1, 2, 4, 8, then 15 minutes), so a marginal link cannot flap.
- Failed tiles are drawn again after 8, 16 and 32 s (then left alone until the next
  success), and when the device comes back online.

Settings (build time, all optional): `NEXT_PUBLIC_VECTOR_TILE_URL` (empty = raster
only), `NEXT_PUBLIC_TILE_URL` / `NEXT_PUBLIC_TILE_ATTRIBUTION` (the raster layer),
`NEXT_PUBLIC_TILE_FALLBACK=off`. See the table in the root README.

## Contract (never change these)

The hostname, paths and origins below are compiled into every shipped app and website
build. An installed app cannot be updated on demand, so changing one of them breaks
every copy still in use (the apps would fall back to OpenStreetMap).

| What | Value | Where it lives |
|---|---|---|
| Hostname | `tiles.kuecker.us`. The `kuecker.us` domain must stay registered and on Cloudflare for as long as any copy of the app is in use. | `DEFAULT_VECTOR_TILE_URL` in `src/lib/api.ts`; `routes` in `wrangler.jsonc` |
| Paths | `/texas/{z}/{x}/{y}.mvt` and `/texas.json` (TileJSON, read for the archive's max zoom) | `src/lib/api.ts`, `src/lib/vectorTiles.ts` |
| App origins | `capacitor://localhost` (iOS), `https://localhost` (Android), `https://txfloods.kuecker.us` (website) | `ALLOWED_ORIGINS` in `wrangler.jsonc`; the Capacitor origin follows `server.hostname`/`androidScheme`/`iosScheme` in `capacitor.config.ts` |
| Tile schema | Protomaps tile schema **4.x** (layer and field names). The apps draw it with `protomaps-leaflet` 5.1.0 + `@protomaps/basemaps` 5.7.2 (`pnpm-lock.yaml`). | `scripts/extract.sh` refuses any other major version |

Only a Protomaps-schema vector tile source can sit behind this URL: the app's map
style names the layers and fields. Moving the hosting (another CDN, a bucket) is fine
as long as the URL and schema stay the same.

Two things wrangler does that can silently break the contract:

- `wrangler deploy` **replaces** the Worker's custom domains with the `routes` in the
  file it deploys. Deploy from this directory, from a checkout whose `wrangler.jsonc`
  still says `tiles.kuecker.us`, and run `pnpm run smoke` afterwards.
- With no `routes` block, `workers_dev` would default to on. The file sets
  `workers_dev` and `preview_urls` to false on purpose.

## Endpoints

| Path | Returns |
|---|---|
| `/{name}/{z}/{x}/{y}.mvt` | Vector tile from `{name}.pmtiles`, gzip, exactly as stored. Canonical numbers only (`/texas/05/…` is a 404). `204` for a valid coordinate with no data. |
| `/{name}.json` | TileJSON (bounds, zoom range, attribution). The Worker sends `max-age=3600`, but the zone's Browser Cache TTL setting raises what browsers hold to 4 hours (see "Cloudflare settings"). |

Only archives named in `ALLOWED_ARCHIVES` (`texas`) are served; any other name is a
404 before the cache or R2 is touched. `HEAD` works like `GET`, `OPTIONS` answers CORS
preflights, other methods are `405`.

Browser requests must come from an origin in `ALLOWED_ORIGINS` (`403` otherwise).
Requests with no `Origin` header (curl, native code) are allowed. This only stops other
*websites* from hotlinking the tiles: any non-browser client can send any `Origin`, and
`capacitor://localhost` is shared by every Capacitor app, so it is not authentication
(see "Abuse and security" below). Capacitor live-reload (a LAN IP) and the Android
emulator (`10.0.2.2`) send other origins and get a `403` by design: the app then shows
its OSM fallback. To test tiles in those setups, forward ports so the origin becomes
`http://localhost:<port>` or run `wrangler dev` with `ALLOWED_ORIGINS='*'`.

## Current archive

Record the numbers `scripts/extract.sh` prints each time the archive is replaced.

| | |
|---|---|
| Protomaps build | `20261001` |
| Zoom range | 0–14 (the app overzooms past 14); the full-detail option is 0–15, about 1.5 GB |
| Bounding box | `-106.7,25.8,-93.5,36.6` (west,south,east,north) = `TX_BOUNDS` in `src/components/MapView.tsx` |
| Size / tiles | 639 MB (669,099,317 bytes); 464,267 addressed tiles, 415,035 entries |
| Tile schema | 4.15.2 |
| OSM data as of | 2026-10-01 04:00 UTC |

OSM data ages with the archive. Roads and bridges change slowly, but refresh at least
once or twice a year, and after a major road or bridge project near flood-prone areas.

## Operations

You need `pmtiles` ([releases](https://github.com/protomaps/go-pmtiles/releases) or
`brew install pmtiles`), Node 22.18+, and free disk about the size of the archive. The
scripts work on Linux and macOS.

### First-time setup (already done for this account)

```bash
cd tiles-worker && pnpm install
npx wrangler login
npx wrangler r2 bucket create texas-flood-map-tiles
# then "Updating the basemap" below, and deploy once:
pnpm run deploy          # NOT `pnpm deploy`: that is a different, built-in pnpm command
pnpm run smoke
```

### Updating the basemap

1. **Cut a new archive.** `scripts/extract.sh` (add `MAXZOOM=14` for the smaller file;
   `scripts/extract.sh 20261101` pins a build date, and is the workaround if the
   "latest build" probe fails). It writes `data/texas.pmtiles.partial`, runs
   `pmtiles verify`, checks the tile schema is still 4.x, prints the schema version and
   the OSM data date, and only then moves the file into place, so a failed run cannot
   leave a truncated archive. (For z15, the old and the partial file coexist briefly:
   mind the disk.) If the schema major changed, it refuses: the apps' map style would
   silently drop roads, water or labels in every installed copy. Upgrade
   `protomaps-leaflet` / `@protomaps/basemaps`, ship the apps, and only then set
   `ALLOW_SCHEMA_CHANGE=1`.
2. **Upload it.** Create an R2 API token (Cloudflare dashboard → R2 → Manage API
   tokens → Object Read & Write on `texas-flood-map-tiles`) with a **short expiry** (a day),
   put it in a private file instead of typing it into a command that lands in your shell
   history (the recipe is in the header of `scripts/upload.sh`), then run
   `scripts/upload.sh`. It verifies the file first, uploads over `texas.pmtiles`, then
   reads the archive back from R2 and compares its header with the local file's.
   **Delete the token afterwards.** (`wrangler r2 object put` is capped at 300 MiB, too
   small for this archive.)
3. **Check production**: `pnpm run smoke`. It also catches the failure that blanks the
   map (tiles gzipped twice), which only exists in Cloudflare's runtime.
4. **How fast it takes effect.** The Worker re-reads the archive header at most a minute
   after an upload, and notices a replaced file on any read that reaches R2. But tiles
   already in the edge cache (`max-age` one week) and in phones' caches stay until they
   expire: purge the `tiles.kuecker.us` cache in the Cloudflare dashboard (Caching →
   Configuration → Purge, by hostname, or everything) after replacing **or deleting** an
   archive. TileJSON is cached for up to 4 hours (an hour in the Worker, raised by the
   zone's Browser Cache TTL), so wait about 5 hours before relying on a changed zoom
   range, and keep the old zoom range available that long when *lowering* max zoom
   (raising it is harmless: the app just overzooms). Deleting an object from R2 does not
   unpublish what is already cached.
5. **Bad upload?** Re-upload the previous archive and purge the cache. Keep the last
   known-good `texas.pmtiles` (the file or the build date to re-extract) until the new
   one has been in production for a while.
6. Update the "Current archive" table above.

### After every deploy or archive swap

`pnpm run smoke` (or `scripts/smoke.sh`) must pass. It never reads secrets.

### Cloudflare settings worth making (dashboard, not code)

These need the Cloudflare dashboard; the Worker cannot do them itself.

- **Exempt `tiles.kuecker.us` from the zone's bot/security features.** The host shares
  the `kuecker.us` zone with the website, so Browser Integrity Check, Bot Fight Mode,
  "Under Attack" mode and a raised security level all apply to tile requests too (a
  scripted `python-urllib` User-Agent already gets a `403` here). A web view cannot
  solve a challenge page: a zone change made during an attack on the *website* would
  turn every installed app's basemap into its OSM fallback. Add a Configuration Rule
  (or WAF skip rule) scoped to `http.host eq "tiles.kuecker.us"` that turns those off.
- **Cache Rule for that host: Browser TTL = "Respect origin".** The zone-wide Browser
  Cache TTL stretches the TileJSON's `max-age` from 1 hour to 4; scoping a rule to the
  host keeps the Worker's own cache headers.
- **Add a rate-limiting rule on that host** (start in log-only mode, with a generous
  per-IP limit: carrier NAT puts many phones behind one IP and a map load is a burst
  of tiles), and a **billing/usage notification** in the account.
- **Monitor it.** `console.warn`/`console.error` (archive missing, R2 errors, and each
  distinct denied `Origin` once per isolate: `origin not allowed: …`) go to Workers Logs
  (dashboard → Workers → this Worker → Logs); request logging is off to keep volume down.
  A burst of `origin not allowed` lines for your own hostname means every client is
  silently on its OSM fallback. The edge cache means `/texas.json` and popular tiles can look
  healthy while R2 is not, so point an external uptime monitor (every 5 minutes, a
  normal browser-like User-Agent) at: `GET /texas.json` (expect `maxzoom` an integer),
  and `GET` a *random* in-bounds z14 tile (a unique path misses the cache; expect `200`
  with `Content-Encoding: gzip` or a `204`). `HEAD` works too, but only `GET` exercises
  R2.

## Abuse and security

- The Worker holds no secrets. The data is public OSM.
- The origin allowlist keeps other websites from embedding the tiles; it does not stop a
  script that sends a fake `Origin`. The cost of abuse is bounded (each request is one
  billed Worker request, with no bandwidth charge from R2) and modest; the rate limit
  and billing notification above are the real ceiling.
- Unknown archive names, padded coordinates and the `.pbf` alias are rejected before any
  R2 or cache work, so only the ~460,000 real tile URLs can ever reach R2.
- Public repo: `data/`, `*.pmtiles`, `.wrangler/`, `.dev.vars*` and the generated
  `worker-configuration.d.ts` are git-ignored. Never commit an R2 token.

## Costs

R2 storage for the archive is inside R2's free tier (10 GB; 10 M reads per month).
**Every tile request is one Worker request, including edge-cache hits**; the edge
cache saves R2 reads and CPU, not request billing. An uncached tile costs up to three
R2 reads (header, directory, tile; the first two are held in memory per isolate). The
$5/month Workers Paid plan includes 10 M requests; extra requests are $0.30 per million.
At about 800 tile requests per user per month that is free up to roughly 12,000 active
users, then about $27/month at 100,000 users and $250/month at 1 M (see
`docs/mobile-data-strategy.md`). The free Workers plan (100 k requests/day) is not
enough once the apps are in use.

## Why a separate Worker (not part of the main one)

- **The main Worker is OpenNext (the whole Next app).** Tile traffic is by far its
  largest request volume; it should not share an isolate, a deploy or an outage with
  the API and the website.
- **Different change cadence.** This code is small and rarely changes; the main Worker
  redeploys on every push to `main` (and sometimes fails to build). The basemap should
  not go down because a gauge-page commit broke a build. This directory is deployed by
  hand with `pnpm run deploy`; the main project's Workers Builds never touches it.
- **The URL is baked into every installed app**, so it needs a home of its own that can
  be moved, cached or fronted without an app update (see the Contract).

It lives in this repo so the app and the tile format stay in step, but is its own
project: own `package.json`, `wrangler.jsonc`, `tsconfig.json` and lockfile. The root
`tsconfig.json`, ESLint config and `.dockerignore` skip it.

## Development

```bash
pnpm install
pnpm run typecheck      # regenerates the worker types, then tsc
pnpm test               # 24 tests: routing, CORS, and the real handler against a fake R2
```

The handler tests (`test/worker.test.ts`) run the real `fetch` handler under Node with
the real `pmtiles` library, a fake R2 bucket and a generated archive (no binary
fixtures). They cannot see two Cloudflare-runtime behaviours the code works around:
`encodeBody: 'manual'` (the runtime would gzip the already-gzipped tile a second time)
and the real Cache API re-encoding a stored body that carries `Content-Encoding`.
Removing either workaround keeps the tests green and blanks the map; `pnpm run smoke`
is what catches them (see `withHeaders` in `src/index.ts`).

To run the Worker locally (workerd) against a small slice and check it with the same
smoke test:

```bash
BBOX=-97.80,30.22,-97.65,30.33 OUT=data/austin.pmtiles scripts/extract.sh
npx wrangler r2 object put texas-flood-map-tiles/austin.pmtiles --file=data/austin.pmtiles --local
npx wrangler dev --port 8787 --var ALLOWED_ARCHIVES:austin --var ALLOWED_ORIGINS:capacitor://localhost --var PUBLIC_HOSTNAME:localhost:8787
BASE=http://localhost:8787 ARCHIVE=austin TILE=15/7487/13490 EMPTY=12/1000/1700 pnpm run smoke
```

## Known trade-offs

- **Vector tiles cost more CPU than raster ones.** First view of the map, measured in
  headless Chromium on a desktop: 0.7–1.3 s versus 0.3–0.5 s for the OSM raster layer;
  under 4× CPU throttling (a mid-range phone) 2.4–4.9 s versus 1.2–2 s; at 6× (a
  low-end phone) up to ~11 s versus ~2 s, with the main thread busy for up to about a
  second at a time. The gauge markers and river overlay draw independently, so the app
  stays usable while the basemap fills in. Headless Chromium rasterizes canvases in
  software while phones use the GPU, so this probably overstates the cost: check on real
  devices (a TestFlight build on an iPhone and an older Android phone). If low-end
  devices are too slow, an automatic "slow device, use raster" mode is a small addition
  on top of the fallback described above.
- **On the wire they are comparable to raster tiles, not heavier.** Transferred (gzip)
  for a first view: dense Austin at z13 395 KB in 6 requests (the 8 OSM raster tiles of the
  same view are 259 KB, 32 KB each); Houston z12 164 KB; Dallas z8 130 KB; rural Hill
  Country z12 47 KB. A data tile also serves every deeper zoom (the app overzooms z14
  data up to z18), so zooming in re-fetches little. Dense city views are the heaviest.
- **Offline**: tiles live in the web view's HTTP cache (one week), not an offline map.
  A cold start with no signal shows only what was cached; a tile that failed while
  offline is drawn again when the device comes back online.
- **Schema drift** is guarded only by the version check in `extract.sh` (see the Contract).
