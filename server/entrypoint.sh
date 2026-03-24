#!/bin/bash
set -e

# ── Mount JuiceFS if credentials are available ──
if [ -n "$JUICEFS_TOKEN" ] && [ -n "$JUICEFS_GCS_KEY_B64" ]; then
  mkdir -p /persistent /root/.juicefs

  # Decode GCS key from base64 env var
  echo "$JUICEFS_GCS_KEY_B64" | base64 -d > /root/.juicefs/gcs-key.json
  export GOOGLE_APPLICATION_CREDENTIALS=/root/.juicefs/gcs-key.json

  VOLUME_NAME="${JUICEFS_VOLUME:-meios-persistent}"
  SUBDIR_ARG=""
  if [ -n "$JUICEFS_SUBDIR" ]; then
    SUBDIR_ARG="--subdir /$JUICEFS_SUBDIR"
  fi

  # Mount JuiceFS in foreground mode (-f), backgrounded by shell.
  # This bypasses jfsmount's hardcoded 10s timeout for -d mode.
  # We poll the mount point ourselves with a generous 60s timeout.
  echo "[entrypoint] mounting JuiceFS volume $VOLUME_NAME at /persistent..."
  /usr/local/bin/jfsmount mount "$VOLUME_NAME" /persistent \
    --token "$JUICEFS_TOKEN" $SUBDIR_ARG \
    --log /var/log/juicefs.log \
    -f &
  JFSMOUNT_PID=$!

  # Poll until mount point is ready (up to 60s)
  TIMEOUT=60
  ELAPSED=0
  while [ $ELAPSED -lt $TIMEOUT ]; do
    # Check if jfsmount process is still alive
    if ! kill -0 $JFSMOUNT_PID 2>/dev/null; then
      echo "[entrypoint] FATAL: jfsmount exited unexpectedly"
      cat /var/log/juicefs.log 2>/dev/null || true
      exit 1
    fi
    # Check if mount point is ready (stat returns different device from parent)
    if mountpoint -q /persistent 2>/dev/null; then
      echo "[entrypoint] JuiceFS mounted (${ELAPSED}s)"
      break
    fi
    sleep 0.5
    ELAPSED=$((ELAPSED + 1))  # approximate, each iteration ~0.5s
  done

  if [ $ELAPSED -ge $TIMEOUT ]; then
    echo "[entrypoint] FATAL: JuiceFS mount timed out after ${TIMEOUT}s"
    cat /var/log/juicefs.log 2>/dev/null || true
    kill $JFSMOUNT_PID 2>/dev/null || true
    exit 1
  fi

  # Use /persistent as workspace if not explicitly set
  export MEIOS_WORKSPACE="${MEIOS_WORKSPACE:-/persistent}"
else
  echo "[entrypoint] JuiceFS not configured, using local workspace"
  export MEIOS_WORKSPACE="${MEIOS_WORKSPACE:-/app/workspace}"
  mkdir -p "$MEIOS_WORKSPACE"
fi

# ── Security: remove shared credentials before handing off to Node.js ──
# JuiceFS FUSE process is already running with credentials in memory.
# The Node.js process (and its agent bash tool) must NOT have access to:
#   - JUICEFS_TOKEN (shared across all users, can mount entire volume)
#   - JUICEFS_GCS_KEY_B64 (shared GCS service account, can access all users' data)
#   - GCS key file on disk
unset JUICEFS_TOKEN JUICEFS_GCS_KEY_B64 JUICEFS_VOLUME JUICEFS_SUBDIR
unset GOOGLE_APPLICATION_CREDENTIALS
rm -f /root/.juicefs/gcs-key.json
echo "[entrypoint] credentials cleared"

# ── Start meios gateway ──
echo "[entrypoint] starting meios gateway..."
if [ -f dist/gateway.mjs ]; then
  exec node dist/gateway.mjs
else
  exec node --import tsx src/gateway.ts
fi
