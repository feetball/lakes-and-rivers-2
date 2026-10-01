#!/usr/bin/env bash
# Cut the Texas basemap out of Protomaps' daily planet build.
#
#   scripts/extract.sh              # latest build, Texas, full detail (z15) -> data/texas.pmtiles
#   scripts/extract.sh 20261001     # a specific build date (also the workaround if the date probe fails)
#   MAXZOOM=14 scripts/extract.sh   # smaller file (~640 MB instead of ~1.5 GB); what is deployed today
#   BBOX=-98,30.1,-97.5,30.5 OUT=data/austin.pmtiles scripts/extract.sh   # small test slice
#
# Needs the `pmtiles` CLI (https://github.com/protomaps/go-pmtiles/releases, or
# `brew install pmtiles`), curl, and free disk of about the archive size. It only
# downloads the tiles inside the bbox (HTTP range requests), so it takes a minute
# or two. Works on Linux and macOS.
#
# Safety: the archive is written to "$OUT.partial", verified, checked against the
# tile schema the apps were built for, and only then moved over $OUT, so a failed
# or interrupted run can never leave a truncated file that upload.sh would push.
# (The old $OUT and the partial file briefly coexist: mind the disk for z15.)
set -euo pipefail
cd "$(dirname "$0")/.."

# Same box the app locks the map to (TX_BOUNDS in src/components/MapView.tsx):
# west,south,east,north.
BBOX="${BBOX:--106.7,25.8,-93.5,36.6}"
MAXZOOM="${MAXZOOM:-15}"   # Protomaps builds stop at z15; the app overzooms past it
OUT="${OUT:-data/texas.pmtiles}"
# The shipped apps draw tiles with @protomaps/basemaps 5.x, which expects the
# Protomaps tile schema 4.x (layer and field names). A newer schema in a future
# daily build can silently drop roads, water or labels in every installed copy.
EXPECTED_SCHEMA_MAJOR="${EXPECTED_SCHEMA_MAJOR:-4}"

command -v pmtiles >/dev/null || { echo "pmtiles CLI not found - see the header of this script" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl not found" >&2; exit 1; }

# Daily builds are named YYYYMMDD.pmtiles. GNU date and BSD (macOS) date differ.
days_ago() {
  date -u -d "-$1 day" +%Y%m%d 2>/dev/null || date -u -v-"$1"d +%Y%m%d
}

build="${1:-}"
if [ -z "$build" ]; then
  reach=$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' https://build.protomaps.com/ || true)
  if [ "$reach" = "000" ] || [ -z "$reach" ]; then
    echo "cannot reach build.protomaps.com (network down?)" >&2
    exit 1
  fi
  # Newest build among the last 10 days.
  for i in $(seq 0 10); do
    d=$(days_ago "$i")
    if curl -sfI --max-time 15 "https://build.protomaps.com/$d.pmtiles" >/dev/null; then build=$d; break; fi
  done
  [ -n "$build" ] || { echo "no Protomaps build found in the last 10 days" >&2; exit 1; }
fi

mkdir -p "$(dirname "$OUT")"
PARTIAL="$OUT.partial"
trap 'rm -f "$PARTIAL"' EXIT
rm -f "$PARTIAL"

echo "Extracting build $build, bbox $BBOX, zoom 0-$MAXZOOM -> $OUT"
pmtiles extract "https://build.protomaps.com/$build.pmtiles" "$PARTIAL" --bbox="$BBOX" --maxzoom="$MAXZOOM"
pmtiles verify "$PARTIAL"

info=$(pmtiles show "$PARTIAL")
schema=$(printf '%s\n' "$info" | awk '$1=="version"{print $2; exit}')
osmtime=$(printf '%s\n' "$info" | awk '$1=="planetiler:osm:osmosisreplicationtime"{print $2; exit}')
echo "Tile schema version: ${schema:-unknown}   OSM data as of: ${osmtime:-unknown}   max zoom: $MAXZOOM"
case "${schema:-}" in
  "$EXPECTED_SCHEMA_MAJOR".*) ;;
  *)
    if [ "${ALLOW_SCHEMA_CHANGE:-}" = 1 ]; then
      echo "WARNING: schema ${schema:-unknown} is not ${EXPECTED_SCHEMA_MAJOR}.x; continuing because ALLOW_SCHEMA_CHANGE=1" >&2
    else
      echo "Refusing: schema ${schema:-unknown} is not ${EXPECTED_SCHEMA_MAJOR}.x, the one the apps' basemap style was built for." >&2
      echo "Upgrade protomaps-leaflet / @protomaps/basemaps and ship the apps first, or set ALLOW_SCHEMA_CHANGE=1 if you have checked." >&2
      exit 1
    fi
    ;;
esac

mv "$PARTIAL" "$OUT"
trap - EXIT
ls -lh "$OUT"
echo "Record the above (build $build, max zoom $MAXZOOM, OSM $osmtime) in tiles-worker/README.md under 'Current archive'."
