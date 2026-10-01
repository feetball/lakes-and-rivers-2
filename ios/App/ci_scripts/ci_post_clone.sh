#!/bin/sh
# Xcode Cloud post-clone hook. Runs after the repo is cloned and before Xcode
# resolves packages and builds. ios/App/App/public (the web bundle) and
# capacitor.config.json are gitignored build outputs, so they have to be
# regenerated here or the app ships an empty web view.
#
# Environment variables on the Xcode Cloud workflow (all optional):
#   MOBILE_API_BASE              where the app fetches gauge data (frozen into the build)
#   NEXT_PUBLIC_VECTOR_TILE_URL  basemap vector tiles; unset = our own tiles.kuecker.us
#                                (src/lib/api.ts). Do not set it to an empty string.
#                                (Checked by scripts/build-mobile.mjs.)
#   NEXT_PUBLIC_TILE_URL / NEXT_PUBLIC_TILE_ATTRIBUTION
#                                the raster layer used as the outage fallback
#                                (OpenStreetMap when unset)
#   NEXT_PUBLIC_TILE_FALLBACK=off  never fall back to a raster layer
set -eu

REPO_ROOT="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/../../.." && pwd)}"
cd "$REPO_ROOT"

echo "[ci] installing Node + pnpm"
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
command -v node >/dev/null 2>&1 || brew install node
corepack enable
corepack prepare "$(node -p "require('./package.json').packageManager")" --activate

[ -n "${MOBILE_API_BASE:-}" ] || echo "[ci] WARNING: MOBILE_API_BASE unset; using the default from next.config.mjs"
# Tile settings are validated by `pnpm mobile:build` below (scripts/build-mobile.mjs): it
# refuses an empty vector URL with no non-OSM raster provider and malformed values.

echo "[ci] pnpm install"
pnpm install --frozen-lockfile

echo "[ci] building web bundle + cap sync"
pnpm mobile:build
