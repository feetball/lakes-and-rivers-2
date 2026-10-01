#!/usr/bin/env bash
# Upload an extracted archive to the R2 bucket the Worker reads.
#
#   export R2_ACCOUNT_ID=...            # Cloudflare dashboard -> R2 -> Overview (right side)
#   export AWS_ACCESS_KEY_ID=...        # R2 -> Manage API tokens -> Create token
#   export AWS_SECRET_ACCESS_KEY=...    #   (Object Read & Write, scoped to the tiles bucket)
#   scripts/upload.sh                   # data/texas.pmtiles -> texas.pmtiles
#
# Uses `pmtiles upload` (multipart over R2's S3 API) because `wrangler r2 object
# put` is capped well below the ~1.5 GB archive. Uploading over an existing
# texas.pmtiles replaces it: the Worker notices the new ETag on its next read.
set -euo pipefail
cd "$(dirname "$0")/.."

FILE="${1:-data/texas.pmtiles}"
BUCKET="${BUCKET:-texas-flood-map-tiles}"
: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}" "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID}" "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"
command -v pmtiles >/dev/null || { echo "pmtiles CLI not found - see scripts/extract.sh" >&2; exit 1; }

pmtiles upload "$FILE" "$(basename "$FILE")" \
  --bucket="s3://$BUCKET?endpoint=https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com&region=auto&use_path_style=true"
