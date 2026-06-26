#!/bin/sh
# Refreshes the main app's live gauge data. Invoked by crond on a schedule.
#
# Two modes, selected by which URL is configured:
#
#   INGEST mode (preferred) — set INGEST_URL to /api/gauges/ingest.
#     The container fetches the ~13 MB NWPS Texas list ITSELF (no time limit
#     here, unlike Vercel's 60 s function cap) and POSTs it to the ingest
#     endpoint, which processes + stores it. This is the only reliable way to
#     get LIVE data into the app, because the slow part — the NWPS fetch — runs
#     here instead of inside a Vercel function that 504s before it finishes.
#
#   PING mode (legacy) — set only REFRESH_URL to /api/cron/refresh-gauges.
#     Just pings the endpoint and lets the app try to fetch NWPS itself. Kept
#     for backward compatibility; will 504 whenever NWPS is slow.
#
# Config (environment):
#   INGEST_URL    - full URL of /api/gauges/ingest (enables INGEST mode)
#   NWPS_URL      - NWPS list endpoint (default: TX state list)
#   REFRESH_URL   - full URL of /api/cron/refresh-gauges (PING mode)
#   CRON_SECRET   - bearer token; must match the main app's CRON_SECRET
#   CURL_TIMEOUT  - max seconds per request (default 120; NWPS is slow)
set -eu

TIMEOUT="${CURL_TIMEOUT:-120}"
NWPS_URL="${NWPS_URL:-https://api.water.noaa.gov/nwps/v1/gauges?state=TX}"

ts() { date -Iseconds; }

# Auth header, only when a secret is configured.
if [ -n "${CRON_SECRET:-}" ]; then
  AUTH_HEADER="Authorization: Bearer ${CRON_SECRET}"
else
  AUTH_HEADER=""
fi

ingest_mode() {
  echo "[$(ts)] fetch NWPS -> ${NWPS_URL}"
  tmp="$(mktemp)"
  # Fetch the raw NWPS list into a temp file. Generous timeout — NWPS takes
  # ~60 s. -f makes curl fail on HTTP errors (e.g. NWPS 504).
  if ! curl -fsS -m "${TIMEOUT}" -A 'texas-flood-map-refresher/1.0' "${NWPS_URL}" -o "${tmp}"; then
    status=$?
    echo "[$(ts)] NWPS fetch FAILED (curl exit ${status}) - will retry next tick" >&2
    rm -f "${tmp}"
    return 1
  fi
  size=$(wc -c < "${tmp}" 2>/dev/null || echo '?')
  echo "[$(ts)] fetched ${size} bytes; POST -> ${INGEST_URL}"

  # POST the raw list to the ingest endpoint, which processes + stores it.
  if [ -n "${AUTH_HEADER}" ]; then
    set -- -H "${AUTH_HEADER}"
  else
    set --
  fi
  if body=$(curl -fsS -m "${TIMEOUT}" -X POST \
      -H 'Content-Type: application/json' \
      "$@" \
      --data-binary "@${tmp}" \
      "${INGEST_URL}"); then
    echo "[$(ts)] ingest ok: ${body}"
    rm -f "${tmp}"
    return 0
  else
    status=$?
    echo "[$(ts)] ingest POST FAILED (curl exit ${status}) - will retry next tick" >&2
    rm -f "${tmp}"
    return 1
  fi
}

ping_mode() {
  echo "[$(ts)] ping -> ${REFRESH_URL}"
  if [ -n "${AUTH_HEADER}" ]; then
    set -- -H "${AUTH_HEADER}"
  else
    set --
  fi
  if body=$(curl -fsS -m "${TIMEOUT}" "$@" "${REFRESH_URL}"); then
    echo "[$(ts)] ok: ${body}"
  else
    status=$?
    echo "[$(ts)] FAILED (curl exit ${status}) - will retry next tick" >&2
  fi
}

if [ -n "${INGEST_URL:-}" ]; then
  ingest_mode
elif [ -n "${REFRESH_URL:-}" ]; then
  ping_mode
else
  echo "[$(ts)] neither INGEST_URL nor REFRESH_URL is set - nothing to do" >&2
  exit 1
fi
