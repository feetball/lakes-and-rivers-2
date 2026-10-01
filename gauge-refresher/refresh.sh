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
#
# In addition to the primary mode above, a SECOND deployment can be pinged on
# every tick (e.g. the Cloudflare Workers copy of the app, which fetches NWPS
# itself):
#   SECONDARY_REFRESH_URL - full URL of the second app's /api/cron/refresh-gauges
#   SECONDARY_CRON_SECRET - bearer token for the second app
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
  # The bulk NWPS TX list sits right at ~60 s and intermittently 504s even from
  # an unbounded client, so retry a few times with backoff before giving up and
  # waiting for the next cron tick. -f makes curl fail (exit 22) on HTTP errors.
  attempts="${NWPS_ATTEMPTS:-4}"
  i=1
  ok=0
  while [ "${i}" -le "${attempts}" ]; do
    # Capture curl's real exit status. Don't use `if ! curl`: that swallows the
    # actual code (it would report the negated test's status, not curl's).
    status=0
    curl -fsS -m "${TIMEOUT}" -A 'texas-flood-map-refresher/1.0' "${NWPS_URL}" -o "${tmp}" || status=$?
    if [ "${status}" -eq 0 ]; then ok=1; break; fi
    echo "[$(ts)] NWPS fetch attempt ${i}/${attempts} failed (curl exit ${status})" >&2
    i=$((i + 1))
    [ "${i}" -le "${attempts}" ] && sleep $((i * 10))
  done
  if [ "${ok}" -ne 1 ]; then
    echo "[$(ts)] NWPS fetch FAILED after ${attempts} attempts - will retry next tick" >&2
    rm -f "${tmp}"
    return 1
  fi
  size=$(wc -c < "${tmp}" 2>/dev/null || echo '?')

  # Gzip the body before POSTing. The raw NWPS TX list is ~13 MB, well over
  # Vercel's 4.5 MB request-body cap (which returns 413 before the function
  # even runs). Gzipped it drops to well under that. The ingest endpoint
  # decompresses based on Content-Encoding: gzip.
  gz="${tmp}.gz"
  if ! gzip -c "${tmp}" > "${gz}"; then
    echo "[$(ts)] gzip FAILED - will retry next tick" >&2
    rm -f "${tmp}" "${gz}"
    return 1
  fi
  gzsize=$(wc -c < "${gz}" 2>/dev/null || echo '?')
  echo "[$(ts)] fetched ${size} bytes (gzip ${gzsize}); POST -> ${INGEST_URL}"

  # POST the gzipped raw list to the ingest endpoint, which decompresses,
  # processes + stores it.
  set -- -H 'Content-Encoding: gzip'
  if [ -n "${AUTH_HEADER}" ]; then
    set -- "$@" -H "${AUTH_HEADER}"
  fi
  status=0
  body=$(curl -fsS -m "${TIMEOUT}" -X POST \
      -H 'Content-Type: application/json' \
      "$@" \
      --data-binary "@${gz}" \
      "${INGEST_URL}") || status=$?
  if [ "${status}" -eq 0 ]; then
    echo "[$(ts)] ingest ok: ${body}"
    rm -f "${tmp}" "${gz}"
    return 0
  else
    echo "[$(ts)] ingest POST FAILED (curl exit ${status}) - will retry next tick" >&2
    rm -f "${tmp}" "${gz}"
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

secondary_ping() {
  echo "[$(ts)] ping secondary -> ${SECONDARY_REFRESH_URL}"
  if [ -n "${SECONDARY_CRON_SECRET:-}" ]; then
    set -- -H "Authorization: Bearer ${SECONDARY_CRON_SECRET}"
  else
    set --
  fi
  if body=$(curl -fsS -m "${TIMEOUT}" "$@" "${SECONDARY_REFRESH_URL}"); then
    echo "[$(ts)] secondary ok: ${body}"
  else
    status=$?
    echo "[$(ts)] secondary FAILED (curl exit ${status}) - will retry next tick" >&2
  fi
}

rc=0
if [ -n "${INGEST_URL:-}" ]; then
  ingest_mode || rc=$?
elif [ -n "${REFRESH_URL:-}" ]; then
  ping_mode || rc=$?
elif [ -z "${SECONDARY_REFRESH_URL:-}" ]; then
  echo "[$(ts)] neither INGEST_URL, REFRESH_URL nor SECONDARY_REFRESH_URL is set - nothing to do" >&2
  exit 1
fi

# The secondary target is independent of the primary, so ping it even when the
# primary call failed.
if [ -n "${SECONDARY_REFRESH_URL:-}" ]; then
  secondary_ping
fi

exit "${rc}"
