#!/usr/bin/env bash
# Upload an extracted archive to the R2 bucket the Worker reads, then check that
# what landed there matches the local file.
#
# Credentials: create an R2 API token (Cloudflare dashboard -> R2 -> Manage API
# tokens -> Object Read & Write on the tiles bucket) with a SHORT expiry (a day
# is plenty), and delete it once the upload is verified. Put it in a private file
# rather than typing it into a command that lands in your shell history:
#
#   read -rp "Access Key ID: " K; read -rsp "Secret Access Key: " V; echo
#   install -m 600 /dev/null ~/.r2-upload.env
#   printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\nR2_ACCOUNT_ID=%s\n' "$K" "$V" "<account id>" > ~/.r2-upload.env; unset K V
#   scripts/upload.sh                   # data/texas.pmtiles -> texas.pmtiles
#
# The file is read from $R2_ENV_FILE (default ~/.r2-upload.env) and must not be
# readable by anyone else. Variables already in the environment win over the file.
#
# Uses `pmtiles upload` (multipart over R2's S3 API) because `wrangler r2 object
# put` is capped at 300 MiB. Uploading over an existing texas.pmtiles replaces it; the
# Worker notices within about a minute, but tiles already cached at the edge and on phones
# stay for up to a week unless the cache is purged (see README, "Updating the basemap").
set -euo pipefail
cd "$(dirname "$0")/.."

FILE="${1:-data/texas.pmtiles}"
BUCKET="${BUCKET:-texas-flood-map-tiles}"
ENV_FILE="${R2_ENV_FILE:-$HOME/.r2-upload.env}"

command -v pmtiles >/dev/null || { echo "pmtiles CLI not found - see scripts/extract.sh" >&2; exit 1; }
[ -f "$FILE" ] || { echo "no such file: $FILE (run scripts/extract.sh first)" >&2; exit 1; }

if [ -f "$ENV_FILE" ]; then
  perms=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")
  case "$perms" in
    600|400) ;;
    *) echo "refusing to read $ENV_FILE: permissions are $perms, run: chmod 600 $ENV_FILE" >&2; exit 1 ;;
  esac
  # Only take variables that are not already set; never echo them.
  while IFS='=' read -r k v || [ -n "$k" ]; do
    case "$k" in AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|R2_ACCOUNT_ID) [ -n "${!k:-}" ] || export "$k=$v" ;; esac
  done < "$ENV_FILE"
fi
: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID (Cloudflare dashboard -> R2 -> Overview)}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"

# Never push a truncated or corrupt archive over the live one.
pmtiles verify "$FILE"

REMOTE_NAME="$(basename "$FILE")"
BUCKET_URL="s3://$BUCKET?endpoint=https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com&region=auto&use_path_style=true"

pmtiles upload "$FILE" "$REMOTE_NAME" --bucket="$BUCKET_URL"

# The archive header (spec version, directory and tile-data offsets and lengths, tile
# counts, zoom range, bounds, tile type) as read back from R2 must equal the local
# file's. That proves the object is the file we sent in layout and size, not a byte-by-byte
# checksum.
local_info=$(pmtiles show "$FILE" | sed -n '1,12p')
remote_info=$(pmtiles show "$REMOTE_NAME" --bucket="$BUCKET_URL" | sed -n '1,12p')
if [ "$local_info" != "$remote_info" ]; then
  echo "UPLOAD CHECK FAILED: the archive in R2 does not match $FILE" >&2
  diff <(printf '%s\n' "$local_info") <(printf '%s\n' "$remote_info") >&2 || true
  exit 1
fi
echo "Uploaded: $REMOTE_NAME in bucket $BUCKET; its header matches $FILE."
echo "Next: scripts/smoke.sh; PURGE the tiles.kuecker.us cache (edge and phones keep old tiles for a week); then delete the R2 token and ~/.r2-upload.env."
