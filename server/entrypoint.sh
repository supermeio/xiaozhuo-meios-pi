#!/bin/bash
set -e

# ── Mount JuiceFS if credentials are available ──
if [ -n "$JUICEFS_TOKEN" ] && [ -n "$JUICEFS_GCS_KEY_B64" ]; then
  mkdir -p /persistent /root/.juicefs

  # Decode GCS key from base64 env var
  echo "$JUICEFS_GCS_KEY_B64" | base64 -d > /root/.juicefs/gcs-key.json
  export GOOGLE_APPLICATION_CREDENTIALS=/root/.juicefs/gcs-key.json

  VOLUME_NAME="${JUICEFS_VOLUME:-meios-persistent}"
  echo "[entrypoint] mounting JuiceFS volume $VOLUME_NAME at /persistent..."
  if [ -n "$JUICEFS_SUBDIR" ]; then
    /usr/local/bin/jfsmount mount "$VOLUME_NAME" /persistent --token "$JUICEFS_TOKEN" --subdir "/$JUICEFS_SUBDIR" -d 2>&1
  else
    /usr/local/bin/jfsmount mount "$VOLUME_NAME" /persistent --token "$JUICEFS_TOKEN" -d 2>&1
  fi
  echo "[entrypoint] JuiceFS mounted"

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
