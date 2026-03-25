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

### Deploy (two-step: build then deploy)

Use the two-step approach (build image first, then deploy from image).
Do NOT use `--source .` — it conflates build and deploy, and can create
revisions with 0% traffic when env vars or secrets are misconfigured.

```bash
cd gateway/

export REGION="us-central1"
export REPO="cloud-run-source-deploy"
export IMAGE="${REGION}-docker.pkg.dev/xiaozhuo-meios-pi/${REPO}/meios-gateway:latest"

# Step 1: build and push image
HTTPS_PROXY=http://127.0.0.1:7890 ALL_PROXY=http://127.0.0.1:7890 \
gcloud builds submit --tag "$IMAGE"

# Step 2: deploy from pre-built image (keeps existing env vars and secrets)
HTTPS_PROXY=http://127.0.0.1:7890 ALL_PROXY=http://127.0.0.1:7890 \
gcloud run deploy meios-gateway \
  --image "$IMAGE" \
  --region "$REGION" \
  --timeout 300
```

### First deploy / update all env vars

Only needed on first deploy or when adding new env vars/secrets.
`--set-env-vars` and `--set-secrets` REPLACE all existing values.

```bash
HTTPS_PROXY=http://127.0.0.1:7890 ALL_PROXY=http://127.0.0.1:7890 \
gcloud run deploy meios-gateway \
  --image "$IMAGE" \
  --region "$REGION" \
  --timeout 300 \
  --set-env-vars "\
SUPABASE_URL=https://exyqukzhnjhbypakhlsp.supabase.co,\
LITELLM_PROXY_URL=https://litellm-proxy-932630247740.us-central1.run.app,\
R2_ENDPOINT=https://7b0a78e27ce19087df60171512443948.r2.cloudflarestorage.com,\
R2_BUCKET=meios-images,\
R2_PUBLIC_URL=https://images.meios.ai,\
FLYIO_APP_NAME=meios-sandbox-test,\
FLYIO_REGION=iad,\
FLYIO_SANDBOX_IMAGE=registry.fly.io/meios-sandbox-test:latest,\
MEIOS_GATEWAY_URL=https://api.meios.ai,\
SUPABASE_DB_HOST=db.exyqukzhnjhbypakhlsp.supabase.co,\
JUICEFS_S3_BUCKET=meios-juicefs,\
JUICEFS_S3_REGION=us-east-1" \
  --set-secrets "\
SUPABASE_SECRET_KEY=SUPABASE_SECRET_KEY:latest,\
SUPABASE_DB_PASSWORD=SUPABASE_DB_PASSWORD:latest,\
LITELLM_MASTER_KEY=LITELLM_MASTER_KEY:latest,\
R2_ACCESS_KEY_ID=R2_ACCESS_KEY_ID:latest,\
R2_SECRET_ACCESS_KEY=R2_SECRET_ACCESS_KEY:latest,\
FLYIO_API_TOKEN=FLYIO_API_TOKEN:latest,\
AWS_ACCESS_KEY_ID=AWS_ACCESS_KEY_ID:latest,\
AWS_SECRET_ACCESS_KEY=AWS_SECRET_ACCESS_KEY:latest,\
GATEWAY_SECRET=GATEWAY_SECRET:latest"
```

### Verify

```bash
curl https://api.meios.ai/ping
# Expected: {"ok":true,"data":{"version":"0.1.0"}}

# If deploy fails (e.g. missing env vars), traffic stays on the last healthy revision.
# Check which revision is serving:
gcloud run revisions list --service meios-gateway --region us-central1 --limit=3

# Verify SSE streaming works:
curl -N https://api.meios.ai/sse-test
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

## Critical: Cloud Run min-instances

LiteLLM proxy **必须**设 `min-instances=1`，否则空闲后缩容到 0，
下次请求触发 Python 冷启动 **~140 秒**，用户体验为 LLM 首 token 等待 2-3 分钟。

```bash
# 已设置，勿改回 0
gcloud run services describe litellm-proxy --region us-central1 \
  --format "value(spec.template.metadata.annotations.'autoscaling.knative.dev/minScale')"
# 应输出: 1
```

**教训（2026-03-25）：** 首 token 延迟 150 秒被误以为是 Kimi K2.5 API 慢或 JuiceFS 慢。
实际通过逐层排查确认：
- 直连 Kimi API: 14s（正常）
- 经 LiteLLM proxy（热）: 10s（正常）
- 经 LiteLLM proxy（冷）: 154s ← 140 秒是 Cloud Run 冷启动

排查方法：
```bash
# 1. 直连 provider API — 确认 provider 本身是否正常
curl https://api.moonshot.ai/v1/chat/completions -H "Authorization: Bearer $KEY" ...

# 2. 经 LiteLLM — 确认 proxy 层是否引入延迟
curl https://litellm-proxy-xxx.run.app/chat/completions -H "Authorization: Bearer $LITELLM_KEY" ...

# 3. 对比冷/热请求 — 确认是否冷启动
# 空闲 15 分钟后再试 vs 立即再试
```

费用影响：`min-instances=1` 约 $5-10/月（取决于 CPU/memory 配置），远小于用户流失的代价。

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| **LLM 首 token 等 2-3 分钟** | **LiteLLM Cloud Run 冷启动（min-instances=0）** | **设 `min-instances=1`，见上方** |
| Cloud Run deploy: `Missing required env var` | `--set-env-vars` replaces ALL vars; old ones are lost | Use `--image` deploy (keeps env vars); only use `--set-env-vars` on first deploy |
| Cloud Run deploy succeeds but 0% traffic | `--source .` deploy can silently fail; revision created but unhealthy | Use two-step deploy (`gcloud builds submit` + `gcloud run deploy --image`) |
| Chat request times out (connection lost) | Cloud Run default timeout is 240s, image generation can exceed that | Set `--timeout 300` on gateway service |
| `supabase db push`: connection timeout | No proxy configured | Add `HTTPS_PROXY=http://127.0.0.1:7890` |
| `supabase db push`: migration history mismatch | Remote has migrations not in local | Run `supabase migration repair --status reverted <ID>` |
| Fly build: `entrypoint.sh not found` | Built from repo root instead of `server/` | `cd server/` before `flyctl deploy` |
| Sandbox health check fails | Machine cold start (~15s) | Wait; gateway retries 20x with 3s intervals |
