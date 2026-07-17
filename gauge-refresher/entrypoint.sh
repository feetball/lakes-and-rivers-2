#!/bin/sh
# Container entrypoint: validate config, write the crontab from the configured
# schedule, fire one refresh immediately (so a fresh container doesn't wait up
# to a full interval), then hand off to crond in the foreground.
set -eu

# Require at least one target URL. INGEST_URL (preferred) makes this container
# fetch NWPS and push the result to /api/gauges/ingest. REFRESH_URL is the
# legacy ping-the-app mode. SECONDARY_REFRESH_URL is an additional deployment
# pinged on every tick. See refresh.sh for the differences.
if [ -z "${INGEST_URL:-}" ] && [ -z "${REFRESH_URL:-}" ] && [ -z "${SECONDARY_REFRESH_URL:-}" ]; then
  echo "[entrypoint] set INGEST_URL (preferred, -> /api/gauges/ingest), REFRESH_URL or SECONDARY_REFRESH_URL (-> /api/cron/refresh-gauges)" >&2
  exit 1
fi
SCHEDULE="${CRON_SCHEDULE:-*/10 * * * *}"

# crond runs jobs with a bare environment, so persist the runtime config to a
# file the cron job sources. Avoids relying on cron inheriting our env.
{
  echo "export INGEST_URL='${INGEST_URL:-}'"
  echo "export REFRESH_URL='${REFRESH_URL:-}'"
  echo "export NWPS_URL='${NWPS_URL:-}'"
  echo "export NWPS_ATTEMPTS='${NWPS_ATTEMPTS:-4}'"
  echo "export CRON_SECRET='${CRON_SECRET:-}'"
  echo "export SECONDARY_REFRESH_URL='${SECONDARY_REFRESH_URL:-}'"
  echo "export SECONDARY_CRON_SECRET='${SECONDARY_CRON_SECRET:-}'"
  echo "export CURL_TIMEOUT='${CURL_TIMEOUT:-120}'"
} > /etc/refresh.env

# Cron line: source config, then run the refresh script, logging to stdout
# (PID 1) so `docker logs` shows every tick.
echo "${SCHEDULE} . /etc/refresh.env && /usr/local/bin/refresh.sh >> /proc/1/fd/1 2>> /proc/1/fd/2" > /etc/crontabs/root

echo "[entrypoint] schedule: ${SCHEDULE}"
echo "[entrypoint] mode:     ${INGEST_URL:+ingest}${INGEST_URL:-ping}"
echo "[entrypoint] target:   ${INGEST_URL:-${REFRESH_URL:-}}"
if [ -n "${SECONDARY_REFRESH_URL:-}" ]; then
  echo "[entrypoint] secondary: ${SECONDARY_REFRESH_URL}"
fi

# Prime the data once on startup rather than waiting for the first tick.
. /etc/refresh.env && /usr/local/bin/refresh.sh || true

# -f foreground, -l 8 log level (logs to stderr, captured by docker).
exec crond -f -l 8
