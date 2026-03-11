# meios — Setup Guide

Deploy your own meios instance: Supabase (auth + DB) → Cloud Run (gateway) → Daytona (per-user sandboxes).

This guide is **agent-friendly**: every step is a concrete command with a verification check. Steps that require human action in a browser are marked with `[HUMAN]`.

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

### 1d. Anthropic API Key

1. Go to https://console.anthropic.com → API Keys → Create Key
2. Note down: `sk-ant-...`

---

## 2. Supabase: Schema & Edge Function

### 2a. Create the database schema

Open the Supabase SQL Editor (https://supabase.com/dashboard/project/$SUPABASE_PROJECT_REF/sql) and run the contents of `gateway/supabase/schema.sql`.

Or via CLI:

```bash
cd gateway
supabase db push --project-ref $SUPABASE_PROJECT_REF
```

**Verify:**
```bash
# Query the table (returns empty array, not an error)
curl -s "https://$SUPABASE_PROJECT_REF.supabase.co/rest/v1/sandboxes?select=id&limit=0" \
  -H "apikey: <your-publishable-key>" \
  -H "Authorization: Bearer <your-publishable-key>"
# Expected: []
```

### 2b. Set Edge Function secrets

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxx --project-ref $SUPABASE_PROJECT_REF
```

> `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by Supabase — do NOT set them manually.

**Verify:**
```bash
supabase secrets list --project-ref $SUPABASE_PROJECT_REF | grep ANTHROPIC_API_KEY
# Expected: one row with name ANTHROPIC_API_KEY
```

### 2c. Deploy the Edge Function

```bash
cd gateway
supabase functions deploy llm-proxy --project-ref $SUPABASE_PROJECT_REF --no-verify-jwt
```

**Verify:**
```bash
supabase functions list --project-ref $SUPABASE_PROJECT_REF | grep llm-proxy
# Expected: one row with STATUS = ACTIVE
```

```bash
# Should return 401 (no token), NOT 500 (misconfigured)
curl -s -o /dev/null -w "%{http_code}" \
  "https://$SUPABASE_PROJECT_REF.supabase.co/functions/v1/llm-proxy/v1/messages" \
  -X POST -H "Content-Type: application/json" -d '{}'
# Expected: 401
```

---

## 3. GCP: Secrets & Cloud Run

### 3a. Store secrets in Secret Manager (one-time)

```bash
echo -n 'sb_secret_xxx' | gcloud secrets create SUPABASE_SECRET_KEY --replication-policy="automatic" --data-file=-
echo -n 'dtn_xxx'       | gcloud secrets create DAYTONA_API_KEY     --replication-policy="automatic" --data-file=-
echo -n 'sk-ant-xxx'    | gcloud secrets create ANTHROPIC_API_KEY   --replication-policy="automatic" --data-file=-
```

**Verify:**
```bash
gcloud secrets list --format="value(name)" | sort
# Expected: ANTHROPIC_API_KEY, DAYTONA_API_KEY, SUPABASE_SECRET_KEY
```

### 3b. Grant Cloud Run access to secrets

```bash
PROJECT_NUMBER=$(gcloud projects describe $GCP_PROJECT --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for SECRET in SUPABASE_SECRET_KEY DAYTONA_API_KEY ANTHROPIC_API_KEY; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:$SA" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet
done
```

**Verify:**
```bash
for SECRET in SUPABASE_SECRET_KEY DAYTONA_API_KEY ANTHROPIC_API_KEY; do
  echo -n "$SECRET: "
  gcloud secrets get-iam-policy $SECRET --format=json 2>/dev/null \
    | grep -c secretAccessor
done
# Expected: each prints "1"
```

### 3c. Create env.cloudrun.yaml

```bash
cat > gateway/env.cloudrun.yaml << 'EOF'
SUPABASE_URL: https://<ref>.supabase.co
DAYTONA_API_URL: https://app.daytona.io/api
EOF
```

> This file is gitignored. Replace `<ref>` with your Supabase project ref.

### 3d. Deploy to Cloud Run

```bash
cd gateway
gcloud run deploy meios-gateway \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --env-vars-file=env.cloudrun.yaml \
  --update-secrets="SUPABASE_SECRET_KEY=SUPABASE_SECRET_KEY:latest,DAYTONA_API_KEY=DAYTONA_API_KEY:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest"
```

**Verify:**
```bash
GATEWAY_URL=$(gcloud run services describe meios-gateway --region us-central1 --format='value(status.url)')
echo "Gateway URL: $GATEWAY_URL"

# Should return 401 (no JWT), NOT 500 (misconfigured)
curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/health"
# Expected: 401
```

### 3e. Verify secrets are mounted (not plaintext)

```bash
gcloud run services describe meios-gateway --region us-central1 \
  --format='yaml(spec.template.spec.containers[0].env)' \
  | grep -A2 'SUPABASE_SECRET_KEY\|DAYTONA_API_KEY\|ANTHROPIC_API_KEY'
# Expected: each shows "valueFrom: secretKeyRef" (NOT "value: sb_secret_...")
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
curl -s -o /dev/null -w "%{http_code}" "https://api.yourdomain.com/health"
# Expected: 401
```

---

## 5. iOS App Configuration

### 5a. Set Supabase credentials

Edit `Meio/Info.plist` (or add to your build configuration):

```xml
<key>SUPABASE_URL</key>
<string>https://<ref>.supabase.co</string>
<key>SUPABASE_PUBLISHABLE_KEY</key>
<string>sb_publishable_xxx</string>
```

### 5b. Set API base URL

In `Meio/Services/MeiosAPI.swift`, update the base URL:

```swift
private let baseURL = "https://api.yourdomain.com"
```

### 5c. Generate Xcode project

```bash
cd /path/to/xiaozhuo-meios-ios
xcodegen generate
```

**Verify:**
```bash
ls Meio.xcodeproj/project.pbxproj
# Expected: file exists
```

---

## 6. Fork Configuration

If you forked this repo, update these defaults:

| File | Field | Change to |
|------|-------|-----------|
| `gateway/src/config.ts` | `meios.repoUrl` | Your fork URL |
| `gateway/src/sandbox.ts` | repo clone URL | Your fork URL |

Since the repo must be **public** for sandboxes to `git clone` it, make sure your fork is also public.

---

## 7. End-to-End Verification

After completing all steps, run this checklist:

```bash
# 1. Gateway responds
curl -s -o /dev/null -w "Gateway: %{http_code}\n" "$GATEWAY_URL/health"
# Expected: 401

# 2. Edge Function responds
curl -s -o /dev/null -w "Edge Function: %{http_code}\n" \
  "https://$SUPABASE_PROJECT_REF.supabase.co/functions/v1/llm-proxy/v1/messages" \
  -X POST -H "Content-Type: application/json" -d '{}'
# Expected: 401

# 3. Supabase Auth works
curl -s "https://$SUPABASE_PROJECT_REF.supabase.co/auth/v1/settings" \
  -H "apikey: <your-publishable-key>" | python3 -c "import sys,json; print('Auth: OK' if json.load(sys.stdin).get('external') else 'Auth: FAIL')"
# Expected: Auth: OK

# 4. Sign up a test user, get JWT, call gateway → should provision sandbox
# (this is the full flow test — requires the iOS app or a curl sequence)
```

---

## Quick Reference: All Secrets & Env Vars

### Secrets (never in source code)

| Name | Where | Format |
|------|-------|--------|
| `SUPABASE_SECRET_KEY` | GCP Secret Manager | `sb_secret_...` |
| `DAYTONA_API_KEY` | GCP Secret Manager | `dtn_...` |
| `ANTHROPIC_API_KEY` | GCP Secret Manager + Supabase Edge Function secrets | `sk-ant-...` |

### Environment Variables (non-sensitive)

| Name | Where | Example |
|------|-------|---------|
| `SUPABASE_URL` | Cloud Run env.cloudrun.yaml | `https://xxx.supabase.co` |
| `DAYTONA_API_URL` | Cloud Run env.cloudrun.yaml | `https://app.daytona.io/api` |

### iOS (client-side, safe to expose)

| Name | Where | Format |
|------|-------|--------|
| `SUPABASE_URL` | Info.plist | `https://xxx.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Info.plist | `sb_publishable_...` |

---

## Updating Secrets

To rotate a secret:

```bash
echo -n 'new-value' | gcloud secrets versions add SECRET_NAME --data-file=-
# Cloud Run picks up :latest on next cold start, or force redeploy:
gcloud run services update meios-gateway --region us-central1 \
  --update-secrets="SECRET_NAME=SECRET_NAME:latest"
```

For the Edge Function:

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-new-value --project-ref $SUPABASE_PROJECT_REF
# Edge Function picks up new value on next invocation
```
