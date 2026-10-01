#!/usr/bin/env bash
# Post-deploy smoke test for the tile Worker. Run it after EVERY deploy or archive
# swap; it checks the behaviours that only exist in Cloudflare's runtime (the unit
# tests in test/ run under Node and cannot see them):
#
#   scripts/smoke.sh                                   # production: https://tiles.kuecker.us
#   BASE=http://localhost:8787 ARCHIVE=austin TILE=15/7487/13490 \
#     EMPTY=12/1000/1700 scripts/smoke.sh              # a local `wrangler dev`; start it with
#       --var ALLOWED_ARCHIVES:austin --var ALLOWED_ORIGINS:capacitor://localhost --var PUBLIC_HOSTNAME:localhost:8787
#       (see "Development" in README.md; the checks need a real allowlist, not '*')
#
# It never reads secrets. Uses a normal curl User-Agent on purpose: the zone's bot
# rule 403s default scripting agents (python-urllib and friends), and so would a
# monitor that used one.
set -uo pipefail

BASE="${BASE:-https://tiles.kuecker.us}"
ARCHIVE="${ARCHIVE:-texas}"
TILE="${TILE:-10/233/421}"      # a tile with data (Austin at z10)
EMPTY="${EMPTY:-12/1000/1700}"  # a valid tile outside the archive's bbox -> 204
ORIGIN="${ORIGIN:-capacitor://localhost}"
UA='curl/8.5.0'

fail=0
pass() { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }
check() { # check "description" <condition exit status>
  if [ "$2" -eq 0 ]; then pass "$1"; else bad "$1"; fi
}
req() { curl -sS -m 25 -A "$UA" "$@"; }                  # body to stdout
hdrs() { req -o /dev/null -D - "$@" | tr -d '\r'; }      # headers to stdout
status() { req -o /dev/null -w '%{http_code}' "$@"; }
hdr() { grep -i "^$1:" | head -1 | cut -d' ' -f2-; }     # value of a header from stdin

URL="$BASE/$ARCHIVE/$TILE.mvt"
echo "Smoke test: $BASE (archive $ARCHIVE, tile $TILE)"

check "GET / is 200"                                      "$([ "$(status "$BASE/")" = 200 ]; echo $?)"

json=$(req "$BASE/$ARCHIVE.json")
check "TileJSON has an integer maxzoom"                   "$(printf '%s' "$json" | grep -Eq '"maxzoom":[0-9]+'; echo $?)"
check "TileJSON advertises this host's tile URL"          "$(printf '%s' "$json" | grep -q "${BASE#*://}/$ARCHIVE/{z}/{x}/{y}.mvt"; echo $?)"

h=$(hdrs -H 'Accept-Encoding: gzip' "$URL")
check "tile is 200"                                       "$(printf '%s' "$h" | head -1 | grep -q ' 200'; echo $?)"
check "tile has Content-Encoding: gzip"                   "$([ "$(printf '%s' "$h" | hdr content-encoding)" = gzip ]; echo $?)"
check "tile has the vector-tile content type"             "$(printf '%s' "$h" | hdr content-type | grep -q 'application/vnd.mapbox-vector-tile'; echo $?)"
check "tile is cacheable (Cache-Control max-age)"         "$(printf '%s' "$h" | hdr cache-control | grep -q 'max-age='; echo $?)"
check "internal X-Tile-Encoding header does not leak"     "$([ -z "$(printf '%s' "$h" | hdr x-tile-encoding)" ]; echo $?)"

# Double-gzip detection (the bug that blanks the map): after the client undoes ONE
# Content-Encoding layer, the body must be a raw vector tile, not another gzip stream.
# Checked on the first request and again on repeats (the edge-cache path).
for attempt in 1 2 3; do
  magic=$(req --compressed -H 'Accept-Encoding: gzip' "$URL" 2>/dev/null | head -c 2 | od -An -tx1 | tr -d ' \n')
  check "request $attempt: body is a raw tile after one decode (not gzipped twice)" "$([ -n "$magic" ] && [ "$magic" != 1f8b ]; echo $?)"
done

case "$BASE" in
  http://localhost*|http://127.*) ;;
  *)
    hit=1
    for _ in 1 2 3 4 5; do
      if hdrs -H 'Accept-Encoding: gzip' "$URL" | grep -qi '^cf-cache-status: HIT'; then hit=0; break; fi
      sleep 1
    done
    check "repeat request is an edge-cache HIT"           "$hit"
    ;;
esac

check "empty tile ($EMPTY) is 204"                        "$([ "$(status "$BASE/$ARCHIVE/$EMPTY.mvt")" = 204 ]; echo $?)"
check "unknown archive is 404"                            "$([ "$(status "$BASE/nope/$TILE.mvt")" = 404 ]; echo $?)"
IFS=/ read -r tz tx ty <<< "$TILE"
check "zero-padded coordinates are 404"                   "$([ "$(status "$BASE/$ARCHIVE/$tz/0$tx/$ty.mvt")" = 404 ]; echo $?)"
check ".pbf alias is 404"                                 "$([ "$(status "$BASE/$ARCHIVE/$TILE.pbf")" = 404 ]; echo $?)"
check "POST is 405"                                       "$([ "$(status -X POST "$URL")" = 405 ]; echo $?)"

head_h=$(req -I -H 'Accept-Encoding: gzip' "$URL" | tr -d '\r')
check "HEAD is 200"                                       "$(printf '%s' "$head_h" | head -1 | grep -q ' 200'; echo $?)"
check "HEAD has Content-Encoding: gzip (and no body)"     "$([ "$(printf '%s' "$head_h" | hdr content-encoding)" = gzip ]; echo $?)"

check "allowed origin gets CORS headers"                  "$([ "$(hdrs -H "Origin: $ORIGIN" "$URL" | hdr access-control-allow-origin)" = "$ORIGIN" ]; echo $?)"
check "preflight is 204"                                  "$([ "$(status -X OPTIONS -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: GET' "$URL")" = 204 ]; echo $?)"
check "disallowed origin is 403"                          "$([ "$(status -H 'Origin: https://evil.example' "$URL")" = 403 ]; echo $?)"

echo
if [ "$fail" -eq 0 ]; then echo "SMOKE TEST PASSED"; else echo "SMOKE TEST FAILED"; fi
exit "$fail"
