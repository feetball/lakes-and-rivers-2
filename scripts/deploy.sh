#!/usr/bin/env bash
#
# Deploy helper for texas-flood-map.
#
#   ./scripts/deploy.sh                  build data if missing, then docker compose up
#   ./scripts/deploy.sh --rebuild-data   force rebuild of waterways.geojson
#   ./scripts/deploy.sh --data-only      only (re)build the data, no container
#   ./scripts/deploy.sh --vercel         rebuild data locally, then `vercel deploy --prod`
#   ./scripts/deploy.sh --stop           docker compose down
#   ./scripts/deploy.sh --logs           tail the running container's logs
#
set -euo pipefail

# Always operate from the repo root.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

MODE="local"
REBUILD_DATA=0
for arg in "$@"; do
  case "$arg" in
    --rebuild-data) REBUILD_DATA=1 ;;
    --data-only)    MODE="data" ;;
    --vercel)       MODE="vercel" ;;
    --stop)         MODE="stop" ;;
    --logs)         MODE="logs" ;;
    -h|--help)      sed -n '3,11p' "${BASH_SOURCE[0]}" | sed 's/^# //'; exit 0 ;;
    *)              echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log()  { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!!\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31mxx\033[0m %s\n" "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' not found in PATH"; }

# docker compose v2 is a plugin; fall back to legacy `docker-compose` if needed.
dc() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    fail "docker compose (v2 plugin or legacy) not found"
  fi
}

build_data() {
  if [ "$REBUILD_DATA" -eq 0 ] && [ -s public/data/waterways.geojson ] && [ -s public/data/gauges-meta.json ]; then
    log "data files present ($(du -h public/data/waterways.geojson | cut -f1)) — skipping rebuild"
    log "pass --rebuild-data to force"
    return 0
  fi
  need node
  log "building waterways.geojson + gauges-meta.json (this takes ~5 min)"
  node scripts/build-waterways-data.mjs
}

case "$MODE" in
  data)
    REBUILD_DATA=1
    build_data
    log "done."
    ;;

  stop)
    need docker
    log "stopping container"
    dc down
    ;;

  logs)
    need docker
    dc logs -f
    ;;

  local)
    need docker
    build_data
    log "building docker image"
    dc build
    log "starting container on :3000"
    dc up -d
    dc ps
    log "open http://localhost:3000"
    log "follow logs with: $0 --logs   ·  stop with: $0 --stop"
    ;;

  vercel)
    need vercel
    build_data
    # Vercel's serverless build step would time out re-fetching NHD/NWPS, so
    # we ship the pre-built data in the deploy context.
    if grep -qE '^public/data/.*\.geojson' .gitignore 2>/dev/null; then
      warn "public/data/*.geojson is in .gitignore."
      warn "Vercel will try to regenerate on build and likely time out."
      warn "Either remove those lines from .gitignore and commit the data,"
      warn "or set VERCEL_IGNORE_DATA_BUILD=1 and provide an external data URL."
      read -r -p "Continue anyway? [y/N] " yn
      [[ "$yn" == "y" || "$yn" == "Y" ]] || exit 1
    fi
    log "deploying to Vercel production"
    vercel deploy --prod
    ;;
esac
