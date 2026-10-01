# Mobile data strategy and economics

Where the apps get their data, what it costs to run, and what has to be
true for a US $0.99 app to make money. Numbers below were measured against
this repo on 2026-09-16 unless marked as an assumption.

## TL;DR

- **Keep the server in the middle.** Phones should read the ~30 KB snapshot
  your Cloudflare Worker already produces, not NOAA's 12.5 MB statewide list.
  That's how the app is built. Per-user cost is effectively zero; the fixed
  cost is Cloudflare's US $5/month Workers plan you already need.
- **The real recurring cost is basemap tiles, not gauge data.** The website
  uses OpenStreetMap's free tile servers, which their policy explicitly does
  not allow for a distributed app. Budget ~US $20/month for a hosted provider
  at launch, or spend a couple of days self-hosting tiles on Cloudflare for
  ~US $0/month. Do not ship to the stores on OSM tiles.
- **Break-even is roughly 500 sales in year one** with a hosted tile
  provider, ~200 if tiles are self-hosted. After that each sale is ~US $0.84
  of margin.
- **Three things to do before the first store build**: put the API on a
  domain you own, pick a tile provider, and redeploy the Worker from this
  branch (it adds the CORS headers the app needs).

## Two ways a phone could get gauge data

### Option A — the app calls NOAA / USGS directly

No backend to run, and the app keeps working even if you stop paying for
anything. That's genuinely attractive for a one-time-purchase app. But the
data sources don't cooperate:

| Source | What the app would need | Measured / known behaviour |
| --- | --- | --- |
| NWPS statewide list (`api.water.noaa.gov/nwps/v1/gauges?state=TX`) | every live reading + NWS flood category, one request | **12.5 MB, 60 s** to download in this session's build; the code base's history is full of 504s at the 60 s mark. On a phone that's ~1 GB/month of the user's data plan at three refreshes a day, and a minute-long spinner. |
| USGS Instantaneous Values | stage for the 602 gauges that have a USGS site, in 7 batched requests | ~150 KB compressed, a few seconds. Misses the 119 NWPS-only gauges (mostly lakes) and NWS's own flood category; the app would compute categories itself from bundled thresholds (the code exists in `src/lib/floodStatus.ts`). |
| NWPS per-gauge forecast | 721 requests per timeline scrub | fine for one gauge, not for the map |
| NWPS hydrograph PNG | one image per gauge sheet | already fetched directly — small, cached, no reason to proxy |
| USGS peak-flow records | one request per gauge sheet | plain-text RDB that needs parsing; the server caches it for a day across all users |

Other problems with "direct": NOAA and USGS rate-limit and can block a
User-Agent, and every installed copy hits them; any upstream API change
breaks all installed apps until a store update ships; and thresholds and
geometry still have to come from somewhere (they're built into the app,
so that part is solved either way).

**Verdict:** not for the statewide picture. Per-gauge extras (the
hydrograph image today; possibly the per-gauge NWPS JSON later) are fine to
fetch directly because they're small and only on tap.

### Option B — your server caches, phones read the cache (what's built)

This is the architecture the repo already has for the website, now used by
the apps:

```
NOAA NWPS ──(every 15 min: Worker cron, or the docker gauge-refresher)──▶ R2 snapshot
                                                                              │
phones ◀──── GET /api/gauges  (192 KB raw · 31 KB gzip · 24 KB brotli) ────────┘
```

- The 60-second, 12.5 MB fetch happens **once per 15 minutes, server-side**,
  regardless of how many users there are. If NWPS is down, the server falls
  back to USGS, and if that fails users keep the previous snapshot.
- The apps ship the river/lake geometry (17 MB) and flood thresholds inside
  the binary, so the only recurring download is the ~30 KB snapshot.
- The apps persist the last good snapshot on the phone. With no signal, the
  map paints from it and shows a notice with the snapshot's timestamp.

### Option C — static snapshot on R2 behind the CDN (for later)

If the Worker ever became a bottleneck, the refresher could write the
snapshot to a public R2 bucket on a custom domain and the app would read it
straight from Cloudflare's cache, with zero Worker invocations on the hot
path. The numbers below show this isn't needed until well past 100,000
active users, so it's noted, not built.

## What Option B costs

Assumptions (stated so you can redo the math): an active user opens the
app 8 times a month; a session makes about 3 API calls (one snapshot, one
records lookup, occasional timeline use). Cloudflare Workers Paid is US
$5/month flat with 10 M requests included, then US $0.30 per million.

| Active users | API requests / month | Worker cost |
| --- | --- | --- |
| 1,000 | ~24,000 | $5 (flat) |
| 10,000 | ~240,000 | $5 |
| 100,000 | ~2.4 M | $5 |
| 1,000,000 | ~24 M | ~$9 |

R2 (snapshot storage and reads) stays inside its free tier throughout.
**Gauge data is not where the money goes.**

Why Workers Paid and not Free: the 15-minute refresh parses NOAA's 12.5 MB
JSON, which blows through the Free plan's 10 ms CPU limit (detail in
[deploying-to-cloudflare.md](deploying-to-cloudflare.md#costs-and-limits--read-this-once)).

## The cost that actually matters: basemap tiles

Every pan and zoom loads map tiles. The website loads them from
`tile.openstreetmap.org`. OSM's
[tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
requires "a distinct, stable User-Agent naming your app", calls out heavy
use such as "distributing an app that uses tiles from openstreetmap.org"
as forbidden without permission, and says they "may block access, without
notice". A paid app on their free servers is exactly what they mean.
The app build already sends its own User-Agent, but the store builds
need a provider that allows commercial use.

Assumption: ~100 tiles per session (a few pans and zooms on a phone),
8 sessions per user per month.

| Provider | Free tier | Paid | 1,000 users (0.8 M tiles/mo) | 10,000 users (8 M tiles/mo) |
| --- | --- | --- | --- | --- |
| OpenStreetMap.org | — | — | **not permitted** | not permitted |
| [Stadia Maps](https://stadiamaps.com/pricing/) | 200k credits, **non-commercial only** | Starter $20/mo for 1 M, +$0.03/1k; Standard $80/mo for 7.5 M, +$0.02/1k | **$20/mo** | ~$90/mo |
| [MapTiler](https://www.maptiler.com/cloud/pricing/) | 100k, non-commercial only | Flex $30/mo for 500k, +$0.15/1k | ~$75/mo | ~$1,150/mo |
| Self-hosted [Protomaps](https://docs.protomaps.com/deploy/cloudflare) PMTiles on Cloudflare R2 | — | R2 storage for a Texas extract (~1–3 GB ≈ pennies), reads served through the same $5 Worker plan | **~$0/mo** | ~$0/mo |

Recommendation:

1. **Self-host Protomaps on R2 — built, see [`tiles-worker/README.md`](../tiles-worker/README.md).**
   A separate small Worker serves a Texas PMTiles archive (~1.5 GB, inside R2's
   free tier) from a hostname you own; the app draws the vector tiles with
   `protomaps-leaflet` on the same Leaflet map, so the river/lake overlay code
   is untouched. The store build points at it with one variable:

   ```bash
   NEXT_PUBLIC_VECTOR_TILE_URL='https://tiles.example.com/texas/{z}/{x}/{y}.mvt' pnpm mobile:build
   ```

   Needs the custom domain (the same one-time chore as the API domain), an R2
   bucket, and about an hour to extract and upload the archive.
2. **Fallback: Stadia Maps Starter** (US $20/month) if you want to ship before
   that's set up. It's a raster tile URL, so switching is two environment
   variables at build time — no code:

   ```bash
   NEXT_PUBLIC_TILE_URL='https://tiles.stadiamaps.com/tiles/osm_bright/{z}/{x}/{y}.png?api_key=YOUR_KEY' \
   NEXT_PUBLIC_TILE_ATTRIBUTION='&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' \
   pnpm mobile:build
   ```

   Their `alidade_smooth_dark` style also suits the app's dark UI. Note the
   API key ends up inside the app bundle; restrict it in the Stadia dashboard
   to the app's User-Agent (`TexasFloodMap/<version>`) and watch usage. The
   tile URL is frozen into every installed copy, so moving off Stadia later
   means an app update; a hostname you own (option 1) avoids that.
3. Keep the **website** on OSM: it's low-traffic, attributed, and sends a
   Referer, which is the use their policy is for.

## The $0.99 math

Both stores take ~15% at this scale: Apple's Small Business Program (15%
under US $1 M/year in proceeds — you must enrol, it isn't automatic) and
Google Play's 15% on the first US $1 M (in the US from mid-2026, 10% plus a
5% billing fee for new installs — same total). Net ≈ **US $0.84 per sale**,
before income tax; the stores handle sales tax.

Fixed costs, first year:

| Item | US $ | Notes |
| --- | --- | --- |
| Apple Developer Program | 99 / year | required |
| Google Play developer account | 25 once | required |
| Cloudflare Workers Paid | 60 / year | you need this for the website anyway |
| Domain for the API | ~12 / year | see "before you ship" |
| Basemap tiles | 240 / year (Stadia Starter) or ~0 (self-hosted) | |
| **Total** | **~436** (hosted tiles) / **~196** (self-hosted) | |

Break-even: **~520 sales** in year one with hosted tiles, **~235** with
self-hosted; about 490 / 205 per year after that. Beyond that it's ~$0.84
margin per sale, because per-user infrastructure cost is nil.

Two honest caveats on a one-time price:

- **You owe every buyer a working app indefinitely.** If the Worker, the
  refresher or the tile account lapses, every installed copy stops showing
  live data, and refund requests follow. The fixed costs above are the
  floor for as long as the app is on sale.
- A subscription (or free app + subscription for extras) is the model that
  matches a recurring server cost, and **push flood alerts** — "the Guadalupe
  at Kerrville just hit action stage" — are the feature people would pay
  monthly for. That's a bigger build (notification server, per-user
  gauge subscriptions, Apple/Google push plumbing). Ship at $0.99 first and
  see whether anyone asks.

## Before you ship (checklist)

1. **API on a domain you own.** `MOBILE_API_BASE` is frozen into every
   installed copy. Today it defaults to the `workers.dev` URL; if that
   Worker is ever renamed or moved, installed apps break until a store
   update. Add a custom domain to the Worker (Cloudflare → Workers → Settings
   → Domains & Routes) and build with `MOBILE_API_BASE=https://api.yourdomain`.
2. **Tile provider** chosen and its build variable(s) set (above) — `NEXT_PUBLIC_VECTOR_TILE_URL` for the self-hosted tiles.
3. **Redeploy the Worker from this branch** (`pnpm cf:deploy`). This branch
   adds `Access-Control-Allow-Origin` headers to `/api/*`; without them the
   app's web view (origin `capacitor://localhost` / `https://localhost`)
   refuses every API response.
4. **Privacy policy page** on the website (both stores require a URL).
   Truthful contents: shows public NOAA/USGS data; location is used only on
   the device to centre the map; sends anonymous usage events (app opened,
   gauge opened, tagged `app:ios` / `app:android` so you can see app vs web
   traffic in the admin panel) with no account or device identifier — the
   server derives a daily-rotating hash and never stores the IP.
5. **Keep the refresher healthy.** Check the admin panel's "Updated" time
   now and then; the app shows users that timestamp, so staleness is visible
   to paying customers.

## Sensible follow-ups (not built)

- **Client-side USGS fallback.** If `/api/gauges` is unreachable for more
  than a few minutes, fetch USGS IV directly from the phone (7 batched
  requests, ~150 KB) and compute categories from the bundled thresholds.
  This is what makes Option A's one real advantage — the app survives the
  backend — available without giving up Option B. About 80 lines, mostly a
  port of `fetchViaUsgsIv` in `src/lib/gauges-fetch.ts`.
- **Precompute forecasts in the refresh.** `/api/gauges/forecast` fetches
  721 NWPS series and caches them in memory per Worker isolate, so a cold
  isolate can take 10–20 s the first time someone scrubs into the future.
  Storing the series alongside the snapshot in R2 during the 15-minute
  refresh makes that instant and removes the burst of upstream calls.
- **Smaller install.** The bundled `waterways.geojson` is 17 MB raw
  (the store compresses it to roughly a third on download). Shipping the
  gzip variant and inflating it in the app with `DecompressionStream`
  would cut the install size, at the cost of an iOS 16.4+ floor.
- **Push alerts** as the paid tier, per the section above.
