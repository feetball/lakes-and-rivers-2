#!/usr/bin/env bash
# Cut the Texas basemap out of Protomaps' daily planet build.
#
#   scripts/extract.sh              # latest build, Texas, full detail (z15) -> data/texas.pmtiles
#   scripts/extract.sh 20261001     # a specific build date
#   MAXZOOM=14 scripts/extract.sh   # smaller file (~670 MB instead of ~1.5 GB)
#   BBOX=-98,30.1,-97.5,30.5 OUT=data/austin.pmtiles scripts/extract.sh   # small test slice
#
# Needs the `pmtiles` CLI (https://github.com/protomaps/go-pmtiles/releases,
# or `brew install pmtiles`) and ~2 GB of free disk. It only downloads the
# tiles inside the bbox (HTTP range requests), so it takes a minute or two.
set -euo pipefail
cd "$(dirname "$0")/.."

# Same box the app locks the map to (TX_BOUNDS in src/components/MapView.tsx):
# west,south,east,north.
BBOX="${BBOX:--106.7,25.8,-93.5,36.6}"
MAXZOOM="${MAXZOOM:-15}"   # Protomaps builds stop at z15; the app overzooms past it
OUT="${OUT:-data/texas.pmtiles}"

command -v pmtiles >/dev/null || { echo "pmtiles CLI not found - see the header of this script" >&2; exit 1; }

build="${1:-}"
if [ -z "$build" ]; then
  # Daily builds are named YYYYMMDD.pmtiles; take the newest of the last 10 days.
  for i in $(seq 0 10); do
    d=$(date -u -d "-$i day" +%Y%m%d)
    if curl -sfI "https://build.protomaps.com/$d.pmtiles" >/dev/null; then build=$d; break; fi
  done
  [ -n "$build" ] || { echo "no Protomaps build found in the last 10 days" >&2; exit 1; }
fi

mkdir -p "$(dirname "$OUT")"
echo "Extracting build $build, bbox $BBOX, zoom 0-$MAXZOOM -> $OUT"
pmtiles extract "https://build.protomaps.com/$build.pmtiles" "$OUT" --bbox="$BBOX" --maxzoom="$MAXZOOM"
pmtiles verify "$OUT"
ls -lh "$OUT"
