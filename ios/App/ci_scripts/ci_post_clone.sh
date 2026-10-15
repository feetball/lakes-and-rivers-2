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
# Xcode Cloud images have no Node. Use node@22 to match the GitHub Actions build,
# and install pnpm with npm: Homebrew's current `node` (25+) no longer bundles
# corepack, so `corepack enable` fails with exit 127.
if ! command -v node >/dev/null 2>&1; then
  brew install node@22
  export PATH="$(brew --prefix node@22)/bin:$PATH"
fi
node --version
PNPM_SPEC="$(node -p "require('./package.json').packageManager.split('+')[0]")"
command -v pnpm >/dev/null 2>&1 && [ "pnpm@$(pnpm --version)" = "$PNPM_SPEC" ] || npm install -g "$PNPM_SPEC"
pnpm --version

[ -n "${MOBILE_API_BASE:-}" ] || echo "[ci] WARNING: MOBILE_API_BASE unset; using the default from next.config.mjs"
# Tile settings are validated by `pnpm mobile:build` below (scripts/build-mobile.mjs): it
# refuses an empty vector URL with no non-OSM raster provider and malformed values.

echo "[ci] pnpm install"
pnpm install --frozen-lockfile

echo "[ci] building web bundle + cap sync"
pnpm mobile:build

# Xcode Cloud builds with automatic package resolution turned off and fails
# without a Package.resolved. We don't commit one: CapApp-SPM/Package.swift
# points at version-stamped paths under node_modules/.pnpm, which only exist
# after the pnpm install above. So resolve here instead. The one remote package
# (capacitor-swift-pm) is pinned with `exact:`, which keeps this reproducible.
# Xcode Cloud's strict setting applies to this xcodebuild too (it refuses with
# exit 74 when there's no Package.resolved), so turn it off just for this
# resolve and put it back afterwards; the real build then finds the file.
echo "[ci] resolving Swift packages"
defaults write com.apple.dt.Xcode IDEDisableAutomaticPackageResolution -bool NO
defaults write com.apple.dt.Xcode IDEPackageOnlyUseVersionsFromResolvedFile -bool NO
xcodebuild -resolvePackageDependencies \
  -project "$REPO_ROOT/ios/App/App.xcodeproj" \
  -scheme App
defaults write com.apple.dt.Xcode IDEDisableAutomaticPackageResolution -bool YES
defaults write com.apple.dt.Xcode IDEPackageOnlyUseVersionsFromResolvedFile -bool YES
test -f "$REPO_ROOT/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
