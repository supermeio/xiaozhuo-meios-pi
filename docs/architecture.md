# meios Architecture

> Updated: 2026-03-25

## Overview

meios is a lightweight vertical AI agent platform. Each user gets an isolated sandbox
(Fly.io Machine) with persistent storage (JuiceFS), running a customizable meio agent.
The platform is designed to support multiple meio types (wardrobe styling, reading assistant,
etc.) through a template system — not locked to a single use case.

Naming: **meio** = a single agent instance; **meios** = the platform.

## Architecture Diagram

```
┌──────────┐     HTTPS      ┌──────────────┐   Proxied    ┌──────────────────┐
│ iOS App  │ ──────────────▶ │  Cloudflare  │ ──────────▶  │  GCP Cloud Run   │
│ (Meio)   │  api.meios.ai  │   (orange)   │              │  Auth Gateway    │
└──────────┘                 └──────────────┘              └────────┬─────────┘
     │                                                         │   │   │
     │ login/signup                              JWKS verify   │   │   │
     ▼                                                         │   │   │
┌──────────────────┐◀──────────────────────────────────────────┘   │   │
│  Supabase Auth   │                                               │   │
└──────────────────┘                                               │   │
┌──────────────────┐◀──────────────────────────────────────────────┘   │
│  Supabase PG     │  sandboxes, billing, JuiceFS metadata             │
└──────────────────┘                                                   │
                              proxy                                    │
     ┌─────────────────────────────────────────┐◀──────────────────────┘
     │  Fly.io Machine (per-user sandbox)      │
     │  ┌───────────────────────────────────┐  │
     │  │  meios gateway (:18800)           │  │
     │  │  pi-agent + Kimi K2.5             │  │
     │  │  SQLite collections (local disk)  │  │
     │  └───────────┬───────────────────────┘  │
     │              │                          │
     │  ┌───────────┴───────────────────────┐  │
     │  │  JuiceFS FUSE (/persistent/)      │  │
     │  │  metadata → Supabase PG           │  │
     │  │  data → AWS S3 us-east-1          │  │
     │  └───────────────────────────────────┘  │
     │              │ LLM calls                │
     └──────────────┼──────────────────────────┘
                    │ via LiteLLM proxy (OpenAI format)
                    ▼
     ┌──────────────────────────────┐
     │  GCP Cloud Run              │
     │  LiteLLM Proxy              │  virtual key auth, rate limit,
     │  (min-instances=1)          │  budget, routing, usage tracking
     └──────────────┬───────────────┘
                    │ real API keys
                    ▼
     ┌──────────────────────────────┐
     │  LLM Providers              │
     │  Moonshot (Kimi K2.5)       │  ← primary
     │  Anthropic / Google / OpenAI│
     └──────────────────────────────┘

     ┌──────────────────────────────┐
     │  Cloudflare R2              │  image CDN (images.meios.ai)
     │  presigned URL upload       │  chokidar auto-sync from sandbox
     └──────────────────────────────┘
```

## Components

### iOS App (Meio)
- SwiftUI, iOS 17+, built with xcodegen
- Supabase Auth SDK (email + password)
- SSE streaming with reconnection logic
- API endpoint: `https://api.meios.ai`

### Auth Gateway (`gateway/`)
- Hono + TypeScript on GCP Cloud Run (us-central1)
- JWT verification via Supabase JWKS (ECC P-256)
- Per-user Fly.io Machine management (provision, start, proxy)
- JuiceFS provisioning (PG schema + S3 IAM per user)
- Image sync API (presigned URL → R2 upload)
- LiteLLM virtual key lifecycle management

### LiteLLM Proxy (`litellm/`)
- [LiteLLM](https://github.com/BerriAI/litellm) on GCP Cloud Run (us-central1)
- **min-instances=1** (Python cold start is 140s, must stay warm)
- Database: shared Supabase Postgres (`LiteLLM_` prefixed tables)

| Feature | Details |
|---------|---------|
| Auth | Virtual key per sandbox, created at provisioning |
| Rate limiting | 60 rpm per virtual key |
| Budget | $5/month per key (free tier), auto-reset every 30 days |
| Routing | Model name → provider (e.g., `kimi-k2.5` → Moonshot) |
| Usage tracking | Per-request token count + cost |
| Multi-provider | Moonshot/Kimi, Anthropic, Google Gemini, OpenAI |

### Supabase
- Auth: ECC P-256 JWT, JWKS verification
- Postgres tables:
  - `sandboxes` — user_id → fly_machine_id, status, gateway_secret
  - `user_plans` — billing period + plan assignment
  - `juicefs_*` schemas — per-user JuiceFS metadata (created at provisioning)
  - `LiteLLM_*` — ~30 tables managed by LiteLLM

### Fly.io Sandbox (per-user)
- Pre-baked Docker image: Node.js 20 + JuiceFS + esbuild bundle (10.5MB)
- Config: 1 shared CPU, 1GB RAM, region `iad`
- `autostop=suspend` / `autostart=true` — memory snapshot resume in 1.5-4.5s
- Gateway port: 18800, auth via `X-Gateway-Secret` header
- Cold start: ~18s (dominated by JuiceFS mount 8s + V8 parse 6s)
- Warm resume (from suspend): 1.5-4.5s

### Persistent Storage (JuiceFS)
- Self-hosted JuiceFS (open source, no dependency on juicefs.com)
- Metadata: Supabase PostgreSQL (per-user schema isolation)
- Data: AWS S3 `us-east-1` bucket `meios-juicefs` (per-user IAM isolation)
- Mount point: `/persistent/` (SOUL.md, MEMORY.md, images/, collections.db backup)
- See [persistent-storage.md](persistent-storage.md) for full details

### Image Delivery
- Storage: Cloudflare R2 via presigned URL upload
- CDN: `images.meios.ai` (zero egress cost)
- Sync: chokidar watches workspace → auto-upload to R2 via gateway presigned URLs
- Generation: Google Gemini native image gen (Nano Banana 2 / Pro)
- See [image-support.md](image-support.md) and [cdn-image-delivery.md](cdn-image-delivery.md)

### meios Server (`server/`, runs inside sandbox)
- Built on [pi-mono](https://github.com/badlogic/pi-mono) (pi-ai + pi-coding-agent)
- Primary model: Kimi K2.5 (see [model-selection.md](model-selection.md))
- Bundled with esbuild into single 10.5MB file (all JS deps inlined)
- SQLite collections DB on local ephemeral disk (async backup to JuiceFS)
- Tools: coding tools (read, write, edit, bash) + domain-specific tools
- Cron: periodic tasks (wardrobe review, heartbeat)
- Unified response envelope: `{ ok, data, error }`

## Request Flows

### User chat request
```
iOS → api.meios.ai (Cloudflare)
    → Auth Gateway (Cloud Run)
        → Verify JWT via JWKS
        → Lookup Fly Machine for user (auto-provision if new)
        → Proxy to Fly.io sandbox (X-Gateway-Secret auth)
            → meios gateway → pi-agent → Kimi K2.5
        ← SSE stream: text-delta, tool-start, tool-end, image, done
    ← Response to iOS
```

### LLM call from sandbox
```
pi-agent (in sandbox)
    → POST ${OPENAI_BASE_URL}/chat/completions
    → LiteLLM Proxy (Cloud Run, direct — no Edge Function relay)
        → validate virtual key, check rate limit + budget
        → route to provider (Moonshot/Kimi, Anthropic, etc.)
    ← response
```

Note: The Supabase Edge Function relay was needed for Daytona (network whitelist).
Fly.io has no network restrictions, so sandboxes connect to LiteLLM directly.

## API Endpoints

### Auth Gateway (api.meios.ai)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/ping` | Public | Health check |
| `POST` | `/api/v1/keys` | JWT/Key | Create API key |
| `GET` | `/api/v1/keys` | JWT/Key | List API keys |
| `DELETE` | `/api/v1/keys/:id` | JWT/Key | Revoke API key |
| `GET` | `/api/v1/sandbox/url` | JWT/Key | Get sandbox direct access URL |
| `POST` | `/internal/v1/sync/presign` | Machine Secret | Presign R2 upload URL |
| `GET` | `/internal/v1/sync/list` | Machine Secret | List R2 objects |
| `DELETE` | `/internal/v1/sync/object` | Machine Secret | Delete R2 object |
| `*` | `/*` | JWT/Key | Proxy to sandbox |

### Sandbox (port 18800, via Gateway)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/chat` | Send a message (supports SSE streaming) |
| `GET` | `/health` | Health check (available before workspace init) |
| `GET` | `/sessions` | List sessions |
| `GET` | `/sessions/:id/messages` | Get session messages |
| `DELETE` | `/sessions/:id` | Delete a session |
| `GET` | `/closet` | Get wardrobe data |
| `GET` | `/images` | List all registered images |
| `GET` | `/collections` | List image collections |
| `POST` | `/collections` | Create collection |
| `GET` | `/collections/:id` | Get collection with images |
| `DELETE` | `/collections/:id` | Delete collection |
| `POST` | `/collections/:id/images` | Add image to collection |
| `DELETE` | `/collections/:id/images/:imgId` | Remove image from collection |
| `GET` | `/fs` | List workspace directory |
| `GET` | `/files/*` | Serve workspace files |
| `PUT` | `/files/*` | Write workspace files |
| `GET` | `/cron` | List cron tasks |

## Environment Variables

### Auth Gateway (Cloud Run)
| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Supabase secret key |
| `SUPABASE_DB_HOST` | Direct PG host for JuiceFS provisioning |
| `SUPABASE_DB_PASSWORD` | PG password |
| `LITELLM_MASTER_KEY` | LiteLLM admin key |
| `LITELLM_PROXY_URL` | LiteLLM Cloud Run URL |
| `FLYIO_API_TOKEN` | Fly.io API token |
| `FLYIO_APP_NAME` | Fly app name (`meios-sandbox-test`) |
| `FLYIO_REGION` | Fly region (`iad`) |
| `FLYIO_SANDBOX_IMAGE` | Docker image for new machines |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 credentials for presigned URLs |
| `R2_ENDPOINT` / `R2_BUCKET` / `R2_PUBLIC_URL` | R2 config |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS admin for JuiceFS IAM provisioning |
| `JUICEFS_S3_BUCKET` / `JUICEFS_S3_REGION` | JuiceFS S3 config |
| `GATEWAY_SECRET` | Shared secret for sandbox auth |

### LiteLLM Proxy (Cloud Run)
| Variable | Description |
|----------|-------------|
| `LITELLM_MASTER_KEY` | Admin key |
| `DATABASE_URL` | Supabase Postgres (pooler, port 5432) |
| `ANTHROPIC_API_KEY` | Real Anthropic key |
| `GOOGLE_API_KEY` | Real Google key |
| `OPENAI_API_KEY` | Real OpenAI key |
| `KIMI_API_KEY` | Real Moonshot key |

### Sandbox (Fly.io Machine env vars)
| Variable | Description |
|----------|-------------|
| `ANTHROPIC_BASE_URL` | LiteLLM proxy URL (all providers share same base) |
| `ANTHROPIC_API_KEY` | LiteLLM virtual key |
| `MEIOS_GATEWAY_URL` | Gateway URL for image sync |
| `MEIOS_USER_ID` | User ID for R2 key layout |
| `GATEWAY_SECRET` | Auth secret for gateway ↔ sandbox |
| `JUICEFS_META_URL` | Per-user PG DSN for JuiceFS metadata |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Per-user S3 credentials for JuiceFS data |
| `R2_PUBLIC_URL` | CDN base URL for image URLs |

## Domain

- **meios.ai** — registered on Cloudflare, WHOIS privacy enabled
- **api.meios.ai** — CNAME → `ghs.googlehosted.com`, Cloudflare Proxy enabled (orange cloud)
- **images.meios.ai** — CNAME → R2 public bucket (Cloudflare CDN)
- SSL: GCP managed certificate + Cloudflare edge TLS

## Security

See [security.md](security.md) for detailed security analysis.

### Key security properties
- **Real API keys never enter sandboxes** — only LiteLLM virtual keys
- **Per-user isolation** — each sandbox has its own PG schema + S3 IAM credentials
- **Credentials cleared after mount** — JuiceFS/S3 creds `unset` after FUSE mount
- **Virtual key = sandbox scope** — rate limited (60 rpm), budgeted ($5/month), revocable
- **LiteLLM Dashboard** — audit trail of all LLM requests

## Operations

See [deploy.md](deploy.md) for full deployment guide.

### Quick reference
```bash
# Gateway (Cloud Run)
cd gateway && gcloud builds submit --tag $IMAGE && gcloud run deploy meios-gateway --image $IMAGE

# Sandbox image (Fly.io)
cd server && flyctl deploy --app meios-sandbox-test --dockerfile Dockerfile --build-only --push

# LiteLLM (Cloud Run)
cd litellm && gcloud run deploy litellm-proxy --source . --port 4000
```

## Key Design Documents

| Document | Topic |
|----------|-------|
| [persistent-storage.md](persistent-storage.md) | JuiceFS architecture, S3 migration, per-user isolation |
| [sandbox-startup-optimization.md](sandbox-startup-optimization.md) | Cold start optimization (50s → 18s → 1.5s suspend) |
| [image-support.md](image-support.md) | Image generation, storage, delivery |
| [model-selection.md](model-selection.md) | Why Kimi K2.5 |
| [deploy.md](deploy.md) | Deployment procedures for all components |
| [strategy.md](strategy.md) | Platform strategy and meio template system |
