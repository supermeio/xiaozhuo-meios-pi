#!/bin/bash
set -e

# ── Mount JuiceFS if credentials are available ──
if [ -n "$JUICEFS_TOKEN" ] && [ -n "$JUICEFS_GCS_KEY_B64" ]; then
  mkdir -p /persistent /root/.juicefs

  # Decode GCS key from base64 env var
  echo "$JUICEFS_GCS_KEY_B64" | base64 -d > /root/.juicefs/gcs-key.json
  export GOOGLE_APPLICATION_CREDENTIALS=/root/.juicefs/gcs-key.json

  VOLUME_NAME="${JUICEFS_VOLUME:-meios-persistent}"
  # JFS_MOUNT_TIMEOUT: works on open-source juicefs >= 1.2.0, may not work on jfsmount (cloud).
  # We add our own retry loop below as a fallback.
  export JFS_MOUNT_TIMEOUT=60

  MOUNT_CMD="/usr/local/bin/jfsmount mount $VOLUME_NAME /persistent --token $JUICEFS_TOKEN"
  if [ -n "$JUICEFS_SUBDIR" ]; then
    MOUNT_CMD="$MOUNT_CMD --subdir /$JUICEFS_SUBDIR"
  fi
  MOUNT_CMD="$MOUNT_CMD -d"

  # Retry mount up to 5 times (covers jfsmount's hardcoded 10s timeout)
  MAX_RETRIES=5
  for attempt in $(seq 1 $MAX_RETRIES); do
    echo "[entrypoint] mounting JuiceFS volume $VOLUME_NAME at /persistent (attempt $attempt/$MAX_RETRIES)..."
    if $MOUNT_CMD 2>&1; then
      echo "[entrypoint] JuiceFS mounted"
      break
    fi
    if [ $attempt -eq $MAX_RETRIES ]; then
      echo "[entrypoint] FATAL: JuiceFS mount failed after $MAX_RETRIES attempts"
      exit 1
    fi
    # Clean up stale mount point before retrying
    fusermount -u /persistent 2>/dev/null || umount /persistent 2>/dev/null || true
    echo "[entrypoint] mount failed, retrying in 3s..."
    sleep 3
  done

  # Use /persistent as workspace if not explicitly set
  export MEIOS_WORKSPACE="${MEIOS_WORKSPACE:-/persistent}"
else
  echo "[entrypoint] JuiceFS not configured, using local workspace"
  export MEIOS_WORKSPACE="${MEIOS_WORKSPACE:-/app/workspace}"
  mkdir -p "$MEIOS_WORKSPACE"
fi

# ── Start meios gateway ──
echo "[entrypoint] starting meios gateway..."
if [ -f dist/gateway.mjs ]; then
  exec node dist/gateway.mjs
else
  exec node --import tsx src/gateway.ts
fi
