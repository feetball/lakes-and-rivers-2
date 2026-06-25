#!/bin/sh
# Container entrypoint: validate config, write the crontab from the configured
# schedule, fire one refresh immediately (so a fresh container doesn't wait up
# to a full interval), then hand off to crond in the foreground.
set -eu

: "${REFRESH_URL:?REFRESH_URL is not set - point it at /api/cron/refresh-gauges}"
SCHEDULE="${CRON_SCHEDULE:-*/10 * * * *}"

# crond runs jobs with a bare environment, so persist the runtime config to a
# file the cron job sources. Avoids relying on cron inheriting our env.
{
  echo "export REFRESH_URL='${REFRESH_URL}'"
  echo "export CRON_SECRET='${CRON_SECRET:-}'"
  echo "export CURL_TIMEOUT='${CURL_TIMEOUT:-90}'"
} > /etc/refresh.env

# Cron line: source config, then run the refresh script, logging to stdout
# (PID 1) so `docker logs` shows every tick.
echo "${SCHEDULE} . /etc/refresh.env && /usr/local/bin/refresh.sh >> /proc/1/fd/1 2>> /proc/1/fd/2" > /etc/crontabs/root

echo "[entrypoint] schedule: ${SCHEDULE}"
echo "[entrypoint] target:   ${REFRESH_URL}"

# Prime the cache once on startup rather than waiting for the first tick.
. /etc/refresh.env && /usr/local/bin/refresh.sh || true

# -f foreground, -l 8 log level (logs to stderr, captured by docker).
exec crond -f -l 8
