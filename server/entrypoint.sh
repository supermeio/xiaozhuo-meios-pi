#!/bin/bash
set -e

# ── Mount JuiceFS (self-hosted: PG metadata + S3 data) ──
if [ -n "$JUICEFS_META_URL" ]; then
  mkdir -p /persistent

  VOLUME_NAME="${JUICEFS_VOLUME_NAME:-default}"
  S3_BUCKET="${JUICEFS_S3_BUCKET:-meios-juicefs}"
  S3_REGION="${JUICEFS_S3_REGION:-us-east-1}"

  # Auto-format on first mount (idempotent — skips if already formatted)
  echo "[entrypoint] formatting JuiceFS volume $VOLUME_NAME (if needed)..."
  /usr/local/bin/juicefs format \
    "$JUICEFS_META_URL" \
    "$VOLUME_NAME" \
    --storage s3 \
    --bucket "https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com" \
    --access-key "$AWS_ACCESS_KEY_ID" \
    --secret-key "$AWS_SECRET_ACCESS_KEY" \
    --no-update 2>&1 || true
  # --no-update: skip format if already formatted, don't error

  echo "[entrypoint] mounting JuiceFS volume $VOLUME_NAME at /persistent..."
  /usr/local/bin/juicefs mount "$JUICEFS_META_URL" /persistent \
    --log /var/log/juicefs.log \
    -f &
  JFSMOUNT_PID=$!

  # Poll until mount point is ready (up to 30s — PG + S3 both in US, should be fast)
  TIMEOUT=30
  ELAPSED=0
  while [ $ELAPSED -lt $TIMEOUT ]; do
    if ! kill -0 $JFSMOUNT_PID 2>/dev/null; then
      echo "[entrypoint] FATAL: juicefs mount exited unexpectedly"
      cat /var/log/juicefs.log 2>/dev/null || true
      exit 1
    fi
    if mountpoint -q /persistent 2>/dev/null; then
      echo "[entrypoint] JuiceFS mounted (${ELAPSED}s)"
      break
    fi
    sleep 0.5
    ELAPSED=$((ELAPSED + 1))
  done

  if [ $ELAPSED -ge $TIMEOUT ]; then
    echo "[entrypoint] FATAL: JuiceFS mount timed out after ${TIMEOUT}s"
    cat /var/log/juicefs.log 2>/dev/null || true
    kill $JFSMOUNT_PID 2>/dev/null || true
    exit 1
  fi

  export MEIOS_WORKSPACE="${MEIOS_WORKSPACE:-/persistent}"
else
  echo "[entrypoint] JuiceFS not configured, using local workspace"
  export MEIOS_WORKSPACE="${MEIOS_WORKSPACE:-/app/workspace}"
  mkdir -p "$MEIOS_WORKSPACE"
fi

# ── Security: remove credentials before handing off to Node.js ──
# JuiceFS FUSE process already has credentials in memory.
# The Node.js process (and its agent bash tool) must NOT have access.
unset JUICEFS_META_URL JUICEFS_VOLUME_NAME JUICEFS_S3_BUCKET JUICEFS_S3_REGION
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
echo "[entrypoint] credentials cleared"

# ── Start meios gateway ──
echo "[entrypoint] starting meios gateway..."
if [ -f dist/gateway.mjs ]; then
  exec node dist/gateway.mjs
else
  exec node --import tsx src/gateway.ts
fi
