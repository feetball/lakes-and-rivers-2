#!/bin/sh
# Pings the main app's gauge-refresh endpoint once. Invoked by crond on a
# schedule (see crontab). All config comes from the environment:
#   REFRESH_URL  - full URL of /api/cron/refresh-gauges on the main app (required)
#   CRON_SECRET  - bearer token; must match the main app's CRON_SECRET (optional,
#                  but the endpoint rejects with 401 if it's set server-side)
#   CURL_TIMEOUT - max seconds for the request (default 90; NWPS upstream is slow)
set -eu

: "${REFRESH_URL:?REFRESH_URL is not set}"
TIMEOUT="${CURL_TIMEOUT:-90}"

ts() { date -Iseconds; }

# Only send the Authorization header when a secret is configured, so this also
# works against an endpoint that has no CRON_SECRET set.
if [ -n "${CRON_SECRET:-}" ]; then
  set -- -H "Authorization: Bearer ${CRON_SECRET}"
else
  set --
fi

echo "[$(ts)] refresh -> ${REFRESH_URL}"
if body=$(curl -fsS -m "${TIMEOUT}" "$@" "${REFRESH_URL}"); then
  echo "[$(ts)] ok: ${body}"
else
  status=$?
  echo "[$(ts)] FAILED (curl exit ${status}) - will retry next tick" >&2
fi
