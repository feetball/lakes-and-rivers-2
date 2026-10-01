#!/bin/sh
# Xcode Cloud post-clone hook. Runs after the repo is cloned and before Xcode
# resolves packages and builds. ios/App/App/public (the web bundle) and
# capacitor.config.json are gitignored build outputs, so they have to be
# regenerated here or the app ships an empty web view.
#
# Set these as environment variables on the Xcode Cloud workflow:
#   MOBILE_API_BASE        where the app fetches gauge data (frozen into the build)
#   NEXT_PUBLIC_TILE_URL   basemap tile URL template (not OSM for store builds)
#   NEXT_PUBLIC_TILE_ATTRIBUTION
set -eu

REPO_ROOT="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/../../.." && pwd)}"
cd "$REPO_ROOT"

echo "[ci] installing Node + pnpm"
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
command -v node >/dev/null 2>&1 || brew install node
corepack enable
corepack prepare "$(node -p "require('./package.json').packageManager")" --activate

[ -n "${MOBILE_API_BASE:-}" ] || echo "[ci] WARNING: MOBILE_API_BASE unset; using the default from next.config.mjs"
[ -n "${NEXT_PUBLIC_TILE_URL:-}" ] || echo "[ci] WARNING: NEXT_PUBLIC_TILE_URL unset; building with OpenStreetMap tiles (not OK for store release)"

echo "[ci] pnpm install"
pnpm install --frozen-lockfile

echo "[ci] building web bundle + cap sync"
pnpm mobile:build
