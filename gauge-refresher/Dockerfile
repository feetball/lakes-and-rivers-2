# Tiny standalone scheduler that pings the main app's gauge-refresh endpoint on
# a cron schedule. Uses Alpine's built-in BusyBox crond (a real cron daemon) so
# ticks land on wall-clock boundaries rather than drifting.
FROM alpine:3.20

RUN apk add --no-cache curl tzdata

COPY refresh.sh /usr/local/bin/refresh.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/refresh.sh /usr/local/bin/entrypoint.sh

# INGEST_URL (preferred) or REFRESH_URL must be supplied at runtime;
# CRON_SECRET / CRON_SCHEDULE / NWPS_URL optional.
ENV CRON_SCHEDULE="*/10 * * * *" \
    CURL_TIMEOUT="120"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
