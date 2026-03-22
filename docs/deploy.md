# Deployment Guide

## Architecture

| Component | Platform | URL |
|-----------|----------|-----|
| Gateway (outer) | GCP Cloud Run (`us-central1`) | `https://api.meios.ai` (via Cloudflare) |
| Sandbox (per-user) | Fly.io Machines (`iad`) | `https://meios-sandbox-test.fly.dev` (internal, via Fly Proxy) |
| LiteLLM Proxy | GCP Cloud Run (`us-central1`) | `https://litellm-proxy-wlymibjy4q-uc.a.run.app` |
| Database | Supabase (US West Oregon) | `exyqukzhnjhbypakhlsp.supabase.co` |
| CDN (images) | Cloudflare R2 | `https://images.meios.ai` |

## Gateway Deployment (Cloud Run)

### Prerequisites
- `gcloud` CLI authenticated with project `xiaozhuo-meios-pi`
- Proxy for China region: `HTTPS_PROXY=http://127.0.0.1:7890`

### Deploy

```bash
cd gateway/

# IMPORTANT: --source deploys do NOT inherit existing env vars/secrets.
# You MUST specify ALL env vars and secrets every time.
HTTPS_PROXY=http://127.0.0.1:7890 ALL_PROXY=http://127.0.0.1:7890 \
gcloud run deploy meios-gateway \
  --source . \
  --region us-central1 \
  --set-env-vars "\
SUPABASE_URL=https://exyqukzhnjhbypakhlsp.supabase.co,\
LITELLM_PROXY_URL=https://litellm-proxy-932630247740.us-central1.run.app,\
R2_ENDPOINT=https://7b0a78e27ce19087df60171512443948.r2.cloudflarestorage.com,\
R2_BUCKET=meios-images,\
R2_PUBLIC_URL=https://images.meios.ai,\
FLYIO_APP_NAME=meios-sandbox-test,\
FLYIO_REGION=iad,\
FLYIO_SANDBOX_IMAGE=registry.fly.io/meios-sandbox-test:latest,\
MEIOS_GATEWAY_URL=https://api.meios.ai" \
  --set-secrets "\
SUPABASE_SECRET_KEY=SUPABASE_SECRET_KEY:latest,\
LITELLM_MASTER_KEY=LITELLM_MASTER_KEY:latest,\
R2_ACCESS_KEY_ID=R2_ACCESS_KEY_ID:latest,\
R2_SECRET_ACCESS_KEY=R2_SECRET_ACCESS_KEY:latest,\
FLYIO_API_TOKEN=FLYIO_API_TOKEN:latest,\
JUICEFS_ACCESS_KEY=JUICEFS_ACCESS_KEY:latest,\
JUICEFS_GCS_KEY_B64=JUICEFS_GCS_KEY_B64:latest,\
GATEWAY_SECRET=GATEWAY_SECRET:latest" \
  --quiet
```

### Verify

```bash
curl https://api.meios.ai/ping
# Expected: {"ok":true,"data":{"version":"0.1.0"}}
```

### Update env vars only (no rebuild)

```bash
# Use --update-env-vars to ADD or CHANGE specific vars without rebuild
HTTPS_PROXY=http://127.0.0.1:7890 ALL_PROXY=http://127.0.0.1:7890 \
gcloud run services update meios-gateway \
  --region us-central1 \
  --update-env-vars "KEY=value"
```

### Rollback

```bash
# List revisions
gcloud run revisions list --service meios-gateway --region us-central1

# Route traffic to a specific revision
gcloud run services update-traffic meios-gateway \
  --region us-central1 \
  --to-revisions=meios-gateway-XXXXX=100
```

## Sandbox Deployment (Fly.io)

### Build & Push Image

```bash
cd server/

# Build from server/ directory (Dockerfile context must be server/)
flyctl deploy --app meios-sandbox-test --dockerfile Dockerfile --build-only --push
```

### Update Existing Machine

```bash
# Get the image tag from build output
IMAGE="registry.fly.io/meios-sandbox-test:deployment-XXXXX"

# Update machine in-place (restarts with new image, keeps env vars)
flyctl machines update <MACHINE_ID> --app meios-sandbox-test --image $IMAGE --yes

# Update gateway to use new image for future provisions
HTTPS_PROXY=http://127.0.0.1:7890 ALL_PROXY=http://127.0.0.1:7890 \
gcloud run services update meios-gateway \
  --region us-central1 \
  --update-env-vars "FLYIO_SANDBOX_IMAGE=$IMAGE"
```

### Destroy & Re-provision

When machine config changes (env vars, services), machines must be destroyed and re-provisioned:

```bash
# 1. Destroy machine
flyctl machines destroy <MACHINE_ID> --app meios-sandbox-test --force

# 2. Delete sandbox record from Supabase
SERVICE_KEY="<service_role_key>"
curl -X DELETE "https://exyqukzhnjhbypakhlsp.supabase.co/rest/v1/sandboxes?user_id=eq.<USER_ID>" \
  -H "apikey: $SERVICE_KEY" \
  -H "Authorization: Bearer $SERVICE_KEY"

# 3. Next authenticated request auto-provisions a new machine
```

### Verify

```bash
# List machines
flyctl machines list -a meios-sandbox-test

# SSH into machine
flyctl ssh console -a meios-sandbox-test -C "ls /persistent/"

# Check logs
flyctl logs -a meios-sandbox-test
```

## Database Migration (Supabase)

### Prerequisites
- `supabase` CLI linked: `supabase link --project-ref exyqukzhnjhbypakhlsp`
- Proxy required for DB connections from China

### Run Migration

```bash
# Create migration file
# File naming: supabase/migrations/YYYYMMDD_description.sql

# Push to remote
HTTPS_PROXY=http://127.0.0.1:7890 ALL_PROXY=http://127.0.0.1:7890 \
supabase db push
```

### If migration history is out of sync

```bash
# Repair remote history to match local files
HTTPS_PROXY=http://127.0.0.1:7890 ALL_PROXY=http://127.0.0.1:7890 \
supabase migration repair --status reverted <MIGRATION_TIMESTAMP>
```

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Cloud Run deploy: `Missing required env var` | `--source` deploy doesn't inherit env vars | Use full `--set-env-vars` + `--set-secrets` |
| `supabase db push`: connection timeout | No proxy configured | Add `HTTPS_PROXY=http://127.0.0.1:7890` |
| `supabase db push`: migration history mismatch | Remote has migrations not in local | Run `supabase migration repair --status reverted <ID>` |
| Fly build: `entrypoint.sh not found` | Built from repo root instead of `server/` | `cd server/` before `flyctl deploy` |
| Sandbox health check fails | Machine cold start (~15s) | Wait; gateway retries 20x with 3s intervals |
