# meios — Setup Guide

> Updated: 2026-03-13

Deploy your own meios instance: Supabase (auth + DB) → LiteLLM (LLM proxy) → Auth Gateway → Daytona (per-user sandboxes).

This guide is **agent-friendly**: every step is a concrete command with a verification check. Steps that require human action in a browser are marked with `[HUMAN]`.

---

## Architecture Overview

```
iOS App → Auth Gateway (Cloud Run) → Daytona Sandbox (per-user)
                                         ↓ LLM calls
                                    Edge Function → LiteLLM Proxy → Providers
```

Two Cloud Run services, one Edge Function:

| Service | Region | Role |
|---------|--------|------|
| `meios-gateway` | us-central1 | Auth, sandbox provisioning, API proxy |
| `litellm-proxy` | us-central1 | LLM routing, rate limiting, budget, usage |
| `llm-proxy` (Edge Function) | Supabase | Network relay (Daytona can't reach *.run.app) |

---

## Prerequisites

| Tool | Install | Verify |
|------|---------|--------|
| Node.js 20+ | `brew install node` | `node -v` |
| gcloud CLI | `brew install google-cloud-sdk` | `gcloud --version` |
| Supabase CLI | `brew install supabase/tap/supabase` | `supabase --version` |
| GitHub CLI | `brew install gh` | `gh --version` |

---

## 1. Create External Accounts

> `[HUMAN]` — these require browser sign-up. Do them once, then never again.

### 1a. GCP Project

1. Go to https://console.cloud.google.com → Create project (e.g., `my-meios`)
2. Enable APIs:

```bash
export GCP_PROJECT=my-meios  # replace with your project ID
gcloud config set project $GCP_PROJECT
gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com
```

**Verify:**
```bash
gcloud services list --enabled --filter="NAME:(run OR secretmanager OR cloudbuild)" --format="value(NAME)"
# Expected: 3 lines
```

### 1b. Supabase Project

1. Go to https://supabase.com → New Project
2. Note down:
   - **Project URL**: `https://<ref>.supabase.co`
   - **Publishable Key**: `sb_publishable_...` (safe to expose)
   - **Secret Key**: `sb_secret_...` (keep private)
   - **DB Password**: (for LiteLLM database connection)

**Verify:**
```bash
export SUPABASE_PROJECT_REF=<ref>  # the part before .supabase.co
supabase projects list | grep $SUPABASE_PROJECT_REF
# Expected: one matching row
```

### 1c. Daytona Account

1. Go to https://app.daytona.io → Sign up
2. Create an API key at https://app.daytona.io/dashboard/keys
3. Note down:
   - **API Key**: `dtn_...`
   - **API URL**: `https://app.daytona.io/api`

### 1d. LLM Provider API Keys

Get keys from the providers you want to support:

| Provider | Console | Key format |
|----------|---------|------------|
| Anthropic | https://console.anthropic.com | `sk-ant-...` |
| Google (Gemini) | https://aistudio.google.com/apikey | `AIza...` |
| OpenAI | https://platform.openai.com/api-keys | `sk-proj-...` |
| Moonshot (Kimi) | https://platform.moonshot.ai | `sk-...` |

At minimum, get one provider key. More providers = more model options.

---

## 2. Supabase: Schema & Edge Function

### 2a. Create the database schema

```bash
cd gateway
supabase db push --linked
```

Or manually: open the Supabase SQL Editor and run `gateway/supabase/schema.sql`, then each file in `gateway/supabase/migrations/` in order.

**Verify:**
```bash
curl -s "https://$SUPABASE_PROJECT_REF.supabase.co/rest/v1/sandboxes?select=id&limit=0" \
  -H "apikey: <your-publishable-key>" \
  -H "Authorization: Bearer <your-publishable-key>"
# Expected: []
```

### 2b. Set Edge Function secret

The Edge Function only needs one secret — the LiteLLM proxy URL (set after deploying LiteLLM in step 3):

```bash
supabase secrets set LITELLM_PROXY_URL=https://litellm-proxy-<project-number>.us-central1.run.app \
  --project-ref $SUPABASE_PROJECT_REF
```

> `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, etc. are auto-injected by Supabase — do NOT set them manually.

**Verify:**
```bash
supabase secrets list --project-ref $SUPABASE_PROJECT_REF | grep LITELLM_PROXY_URL
# Expected: one row
```

### 2c. Deploy the Edge Function

```bash
cd gateway
supabase functions deploy llm-proxy --project-ref $SUPABASE_PROJECT_REF --no-verify-jwt
```

**Verify:**
```bash
curl -s -o /dev/null -w "%{http_code}" \
  "https://$SUPABASE_PROJECT_REF.supabase.co/functions/v1/llm-proxy/v1/messages" \
  -X POST -H "Content-Type: application/json" -d '{}'
# Expected: 401 (not 500)
```

### 2d. Enable email confirmation

> `[HUMAN]` — Supabase Dashboard → Authentication → Providers → Email → Enable email confirmations.

---

## 3. GCP: Secrets & Cloud Run

### 3a. Store secrets in Secret Manager

```bash
# Auth Gateway secrets
echo -n 'sb_secret_xxx'    | gcloud secrets create SUPABASE_SECRET_KEY --replication-policy="automatic" --data-file=-
echo -n 'dtn_xxx'          | gcloud secrets create DAYTONA_API_KEY     --replication-policy="automatic" --data-file=-

# LiteLLM Proxy secrets
echo -n 'sk-litellm-xxx'   | gcloud secrets create LITELLM_MASTER_KEY --replication-policy="automatic" --data-file=-
echo -n 'postgresql://...' | gcloud secrets create DATABASE_URL       --replication-policy="automatic" --data-file=-
echo -n 'sk-ant-xxx'       | gcloud secrets create ANTHROPIC_API_KEY  --replication-policy="automatic" --data-file=-
echo -n 'AIzaXxx'          | gcloud secrets create GOOGLE_API_KEY     --replication-policy="automatic" --data-file=-
echo -n 'sk-proj-xxx'      | gcloud secrets create OPENAI_API_KEY     --replication-policy="automatic" --data-file=-
echo -n 'sk-xxx'           | gcloud secrets create KIMI_API_KEY       --replication-policy="automatic" --data-file=-
echo -n 'your-ui-password' | gcloud secrets create UI_PASSWORD        --replication-policy="automatic" --data-file=-
```

> **DATABASE_URL** format: `postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres`

**Verify:**
```bash
gcloud secrets list --format="value(name)" | sort
# Expected: 9 secrets
```

### 3b. Grant Cloud Run access to secrets

```bash
PROJECT_NUMBER=$(gcloud projects describe $GCP_PROJECT --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for SECRET in SUPABASE_SECRET_KEY DAYTONA_API_KEY LITELLM_MASTER_KEY DATABASE_URL \
              ANTHROPIC_API_KEY GOOGLE_API_KEY OPENAI_API_KEY KIMI_API_KEY UI_PASSWORD; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:$SA" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet
done
```

**Verify:**
```bash
for SECRET in SUPABASE_SECRET_KEY DAYTONA_API_KEY LITELLM_MASTER_KEY; do
  echo -n "$SECRET: "
  gcloud secrets get-iam-policy $SECRET --format=json 2>/dev/null | grep -c secretAccessor
done
# Expected: each prints "1"
```

### 3c. Deploy LiteLLM Proxy

```bash
cd litellm
gcloud run deploy litellm-proxy \
  --source . \
  --region us-central1 \
  --port 4000 \
  --set-env-vars="UI_USERNAME=admin,LITELLM_MASTER_KEY_HASH=ignore" \
  --update-secrets="LITELLM_MASTER_KEY=LITELLM_MASTER_KEY:latest,DATABASE_URL=DATABASE_URL:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,GOOGLE_API_KEY=GOOGLE_API_KEY:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,KIMI_API_KEY=KIMI_API_KEY:latest,UI_PASSWORD=UI_PASSWORD:latest" \
  --project=$GCP_PROJECT
```

**Verify:**
```bash
LITELLM_URL=$(gcloud run services describe litellm-proxy --region us-central1 --format='value(status.url)')
echo "LiteLLM URL: $LITELLM_URL"

curl -s -o /dev/null -w "%{http_code}" "$LITELLM_URL/health"
# Expected: 200
```

> Save `$LITELLM_URL` — you'll need it for the gateway and Edge Function.

Now set the Edge Function secret (from step 2b) if you haven't:
```bash
supabase secrets set LITELLM_PROXY_URL=$LITELLM_URL --project-ref $SUPABASE_PROJECT_REF
```

### 3d. Deploy Auth Gateway

```bash
cd gateway

cat > env.cloudrun.yaml << EOF
SUPABASE_URL: https://$SUPABASE_PROJECT_REF.supabase.co
DAYTONA_API_URL: https://app.daytona.io/api
LITELLM_PROXY_URL: $LITELLM_URL
EOF

gcloud run deploy meios-gateway \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --env-vars-file=env.cloudrun.yaml \
  --update-secrets="SUPABASE_SECRET_KEY=SUPABASE_SECRET_KEY:latest,DAYTONA_API_KEY=DAYTONA_API_KEY:latest,LITELLM_MASTER_KEY=LITELLM_MASTER_KEY:latest" \
  --project=$GCP_PROJECT
```

> `env.cloudrun.yaml` is gitignored. Gateway only needs 3 secrets — provider keys stay on LiteLLM only.

**Verify:**
```bash
GATEWAY_URL=$(gcloud run services describe meios-gateway --region us-central1 --format='value(status.url)')

# Should return OK (public endpoint)
curl -s "$GATEWAY_URL/ping"
# Expected: {"ok":true,"data":{"version":"0.1.0"}}

# Should return 401 (auth required)
curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/chat"
# Expected: 401
```

### 3e. Verify no plaintext secrets

```bash
# Gateway: all sensitive values should be secretKeyRef
gcloud run services describe meios-gateway --region us-central1 \
  --format='yaml(spec.template.spec.containers[0].env)' \
  | grep -B1 "value:" | grep -v "valueFrom"
# Expected: only SUPABASE_URL, DAYTONA_API_URL, LITELLM_PROXY_URL (non-sensitive)

# LiteLLM: same check
gcloud run services describe litellm-proxy --region us-central1 \
  --format='yaml(spec.template.spec.containers[0].env)' \
  | grep -B1 "value:" | grep -v "valueFrom"
# Expected: only UI_USERNAME, LITELLM_MASTER_KEY_HASH (non-sensitive)
```

---

## 4. Custom Domain (optional)

### 4a. Map domain in Cloud Run

```bash
gcloud beta run domain-mappings create \
  --service meios-gateway \
  --domain api.yourdomain.com \
  --region us-central1
```

### 4b. DNS

Add a CNAME record: `api.yourdomain.com → ghs.googlehosted.com`

If using Cloudflare, set SSL/TLS mode to **Full** (not Flexible).

**Verify:**
```bash
curl -s "https://api.yourdomain.com/ping"
# Expected: {"ok":true,"data":{"version":"0.1.0"}}
```

---

## 5. iOS App Configuration

### 5a. Set Supabase credentials

Edit `Meio/Info.plist`:

```xml
<key>SUPABASE_URL</key>
<string>https://<ref>.supabase.co/auth/v1</string>
<key>SUPABASE_PUBLISHABLE_KEY</key>
<string>sb_publishable_xxx</string>
```

### 5b. Set team and bundle ID

Edit `project.yml`:

```yaml
settings:
  base:
    DEVELOPMENT_TEAM: YOUR_TEAM_ID

targets:
  Meio:
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: your.bundle.id
```

### 5c. Generate and build

```bash
xcodegen generate
open Meio.xcodeproj
```

**Verify:** Build and run on simulator. Sign up → chat should work.

---

## 6. Fork Configuration

If you forked this repo, update:

| File | Field | Change to |
|------|-------|-----------|
| `gateway/src/config.ts` | `meios.repoUrl` | Your fork URL |

The repo must be **public** for sandboxes to `git clone` it.

---

## 7. End-to-End Verification

```bash
# 1. Gateway ping (public)
curl -s "$GATEWAY_URL/ping"
# Expected: {"ok":true,...}

# 2. Edge Function (returns 401, not 500)
curl -s -o /dev/null -w "%{http_code}" \
  "https://$SUPABASE_PROJECT_REF.supabase.co/functions/v1/llm-proxy/v1/messages" \
  -X POST -H "Content-Type: application/json" -d '{}'
# Expected: 401

# 3. LiteLLM health
curl -s -o /dev/null -w "%{http_code}" "$LITELLM_URL/health"
# Expected: 200

# 4. Sign up → get JWT → create API key → chat
ANON_KEY="<your-publishable-key>"
# Sign up
curl -s "https://$SUPABASE_PROJECT_REF.supabase.co/auth/v1/signup" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"testpass123"}'

# [HUMAN] Confirm email, then sign in:
JWT=$(curl -s "https://$SUPABASE_PROJECT_REF.supabase.co/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"testpass123"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# Create API key
API_KEY=$(curl -s -X POST "$GATEWAY_URL/api/v1/keys" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"name":"test"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['key'])")
echo "API Key: $API_KEY"

# Chat (first call provisions sandbox — may take ~2 min)
curl -s --max-time 180 "$GATEWAY_URL/chat" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello"}'
# Expected: {"ok":true,"data":{"reply":"...","sessionId":"..."}}
```

---

## Quick Reference

### Cloud Run Services

| Service | Secrets | Env Vars |
|---------|---------|----------|
| **meios-gateway** | `SUPABASE_SECRET_KEY`, `DAYTONA_API_KEY`, `LITELLM_MASTER_KEY` | `SUPABASE_URL`, `DAYTONA_API_URL`, `LITELLM_PROXY_URL` |
| **litellm-proxy** | `LITELLM_MASTER_KEY`, `DATABASE_URL`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `KIMI_API_KEY`, `UI_PASSWORD` | `UI_USERNAME`, `LITELLM_MASTER_KEY_HASH` |

### Supabase Edge Function

| Secret | Purpose |
|--------|---------|
| `LITELLM_PROXY_URL` | LiteLLM Cloud Run URL (the only manual secret) |
| `SUPABASE_*` | Auto-injected by Supabase (do not set manually) |

### GCP Secret Manager (9 secrets)

| Secret | Used by | Format |
|--------|---------|--------|
| `SUPABASE_SECRET_KEY` | Gateway | `sb_secret_...` |
| `DAYTONA_API_KEY` | Gateway | `dtn_...` |
| `LITELLM_MASTER_KEY` | Gateway + LiteLLM | `sk-litellm-...` |
| `DATABASE_URL` | LiteLLM | `postgresql://...` |
| `ANTHROPIC_API_KEY` | LiteLLM | `sk-ant-...` |
| `GOOGLE_API_KEY` | LiteLLM | `AIza...` |
| `OPENAI_API_KEY` | LiteLLM | `sk-proj-...` |
| `KIMI_API_KEY` | LiteLLM | `sk-...` |
| `UI_PASSWORD` | LiteLLM | Dashboard password |

### iOS (client-side, safe to expose)

| Name | Where | Format |
|------|-------|--------|
| `SUPABASE_URL` | Info.plist | `https://xxx.supabase.co/auth/v1` |
| `SUPABASE_PUBLISHABLE_KEY` | Info.plist | `sb_publishable_...` |

---

## Redeploying

```bash
# Auth Gateway
cd gateway && gcloud run deploy meios-gateway --source . --region us-central1 --allow-unauthenticated

# LiteLLM Proxy
cd litellm && gcloud run deploy litellm-proxy --source . --region us-central1 --port 4000

# Edge Function
cd gateway && supabase functions deploy llm-proxy --project-ref $SUPABASE_PROJECT_REF --no-verify-jwt
```

## Rotating Secrets

```bash
# GCP Secret Manager
echo -n 'new-value' | gcloud secrets versions add SECRET_NAME --data-file=-
# Cloud Run picks up :latest on next cold start, or force:
gcloud run services update SERVICE_NAME --region us-central1 \
  --update-secrets="SECRET_NAME=SECRET_NAME:latest"

# Supabase Edge Function
supabase secrets set LITELLM_PROXY_URL=new-url --project-ref $SUPABASE_PROJECT_REF
```
