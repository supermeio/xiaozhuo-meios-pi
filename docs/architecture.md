# meios Architecture

> Updated: 2026-03-12

## Overview

meios is a lightweight vertical AI agent platform for wardrobe/outfit assistance. Each user gets an isolated sandbox with their own agent instance. LLM calls are routed through [LiteLLM](https://docs.litellm.ai/) for unified auth, rate limiting, budget management, and multi-provider support.

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
│  Supabase PG     │  query sandboxes + LiteLLM tables                 │
└──────────────────┘                                                   │
                              proxy (signed URL)                       │
     ┌─────────────────────────────────┐◀──────────────────────────────┘
     │     Daytona Sandbox (per-user)  │
     │  ┌───────────────────────────┐  │
     │  │  meios gateway (:18800)   │  │
     │  │  pi-agent + Gemini Flash  │  │
     │  └───────────┬───────────────┘  │
     │              │ LLM calls        │
     └──────────────┼──────────────────┘
                    │ Authorization: Bearer <LiteLLM virtual key>
                    ▼
     ┌──────────────────────────────┐
     │  Supabase Edge Function     │  *.supabase.co (Daytona 白名单)
     │  (llm-proxy — thin relay)   │
     └──────────────┬───────────────┘
                    │ Bearer <virtual key>
                    ▼
     ┌──────────────────────────────┐
     │  GCP Cloud Run              │
     │  LiteLLM Proxy              │  virtual key 鉴权, rate limit,
     │  litellm-proxy              │  budget, routing, usage tracking
     └──────────────┬───────────────┘
                    │ real API keys
                    ▼
     ┌──────────────────────────────┐
     │  LLM Providers              │
     │  Anthropic / Google Gemini  │
     │  OpenAI / Moonshot (Kimi)   │
     └──────────────────────────────┘
```

## Components

### iOS App (Meio)
- SwiftUI, iOS 17+, built with xcodegen
- Supabase Auth SDK (email + password)
- API endpoint: `https://api.meios.ai`

### Auth Gateway (`gateway/`)
- Hono + TypeScript on GCP Cloud Run (us-central1)
- JWT verification via Supabase JWKS (ECC P-256)
- Per-user sandbox routing with signed URL management
- Auto-provisions sandbox for new users on first request
- LLM proxy routes relay to LiteLLM (thin relay, no business logic)

### LiteLLM Proxy (`litellm/`)
- [LiteLLM](https://github.com/BerriAI/litellm) on GCP Cloud Run (us-central1)
- URL: Cloud Run service URL (see `LITELLM_PROXY_URL` env var)
- Dashboard: `${LITELLM_PROXY_URL}/ui/` (admin / master key)
- Config: `litellm/config.yaml`
- Database: shared Supabase Postgres (`LiteLLM_` prefixed tables)
- Resources: 1 vCPU, 1 GB RAM, min 0 / max 3

**Responsibilities:**
| Feature | Details |
|---------|---------|
| Auth | Virtual key per sandbox, created via `/key/generate` at provisioning |
| Rate limiting | 60 rpm per virtual key |
| Budget | $5/month per key (free tier), auto-reset every 30 days |
| Routing | Model name → provider (e.g., `gemini-3.1-flash-lite-preview` → Google) |
| Usage tracking | Per-request token count + cost, queryable via API and Dashboard |
| Multi-provider | Anthropic, Google Gemini, OpenAI, Moonshot/Kimi |

**Supported endpoints:**
| Endpoint | Format | Use case |
|----------|--------|----------|
| `/chat/completions` | OpenAI format | Primary — all providers via translation |
| `/anthropic/v1/messages` | Anthropic native (pass-through) | Claude tool calling — zero translation |

### Supabase Edge Function (`gateway/supabase/functions/llm-proxy/`)
- **Thin relay** — exists solely as a network hop
- Daytona sandboxes (Tier 1/2) can reach `*.supabase.co` but NOT `*.run.app`
- Extracts virtual key from request, forwards to LiteLLM, returns response
- ~100 lines, no business logic (auth/rate-limit/budget all handled by LiteLLM)
- Deployed with `--no-verify-jwt` (LiteLLM validates the virtual key)

**Path mapping:**
| Incoming path | LiteLLM target | Format |
|---------------|---------------|--------|
| `/v1/messages*` | `/anthropic/v1/messages*` | Anthropic native (pass-through) |
| `/chat/completions` | `/chat/completions` | OpenAI format |
| `/openai/*` | `/openai/*` | OpenAI native |

### Supabase
- Auth: ECC P-256 JWT, JWKS verification
- Postgres tables:
  - `sandboxes` — user_id → daytona_id, signed_url, LiteLLM key name
  - `user_plans` — billing period + plan assignment
  - `LiteLLM_*` — ~30 tables managed by LiteLLM (virtual keys, spend logs, budgets, etc.)

### Daytona Sandbox (per-user)
- Image: `node:20-slim`, 2 CPU, 2GB RAM, 5GB disk
- Auto-provision: create LiteLLM virtual key → create sandbox → clone repo → npm install → start gateway
- Gateway port: 18800
- Signed URL: 24h TTL, auto-refresh 1h before expiry, retry on 401
- Auto-archive after 7 days of inactivity

### meios Server (`server/`, runs inside sandbox)
- Repo: [supermeio/xiaozhuo-meios-pi](https://github.com/supermeio/xiaozhuo-meios-pi)
- Built on [pi-mono](https://github.com/badlogic/pi-mono) (pi-ai + pi-coding-agent)
- Primary model: Gemini 3.1 Flash Lite via OpenAI format
- Claude available via Anthropic native pass-through (for coding tasks)
- Unified response envelope: `{ ok, data, error }`
- Tools: coding tools (read, write, edit, bash) + wardrobe tools

## Request Flows

### User chat request
```
iOS → api.meios.ai (Cloudflare)
    → Auth Gateway (Cloud Run)
        → Verify JWT via JWKS
        → Lookup sandbox signed URL (auto-provision if new user)
        → Proxy to Daytona sandbox
            → meios gateway → pi-agent
        ← { ok, data: { reply, sessionId } }
    ← Response to iOS
```

### LLM call from sandbox (OpenAI format — primary path)
```
pi-agent: getModel('openai', 'gemini-3.1-flash-lite-preview')
    → POST ${OPENAI_BASE_URL}/chat/completions
    → Edge Function (thin relay)
    → LiteLLM /chat/completions
        → validate virtual key, check rate limit + budget
        → translate OpenAI → Gemini native format
        → POST generativelanguage.googleapis.com
    ← translate Gemini → OpenAI response
    ← { choices, usage }
```

### LLM call from sandbox (Anthropic native — for Claude)
```
pi-agent: getModel('anthropic', 'claude-haiku-4-5')
    → POST ${ANTHROPIC_BASE_URL}/v1/messages
    → Edge Function (thin relay, forwards anthropic-version header)
    → LiteLLM /anthropic/v1/messages (pass-through, no translation)
        → validate virtual key, check rate limit + budget
        → POST api.anthropic.com/v1/messages (native format)
    ← Anthropic response (native, tool_use blocks preserved)
```

## API Endpoints

### Auth Gateway (api.meios.ai)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/ping` | Public | Health check |
| `POST` | `/api/v1/keys` | JWT/Key | Create API key |
| `GET` | `/api/v1/keys` | JWT/Key | List API keys |
| `DELETE` | `/api/v1/keys/:id` | JWT/Key | Revoke API key |
| `GET` | `/api/v1/sandbox/url` | JWT/Key | Get sandbox direct access URL |
| `*` | `/*` | JWT/Key | Proxy to sandbox |

Auth supports Supabase JWT or meios API key (`meios_` prefix). See [AGENTS.md](../AGENTS.md) for agent integration guide.

OpenAPI spec: [openapi.yaml](../openapi.yaml)

### Sandbox (port 18800, via Gateway or direct URL)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/chat` | Send a message |
| `GET` | `/health` | Health check |
| `GET` | `/sessions` | List sessions |
| `GET` | `/sessions/:id/messages` | Get session messages |
| `DELETE` | `/sessions/:id` | Delete a session |
| `GET` | `/closet` | Get wardrobe data |
| `GET` | `/cron` | Cron tasks |

## Environment Variables

### Auth Gateway (Cloud Run)
| Variable | Source | Description |
|----------|--------|-------------|
| `SUPABASE_URL` | env | Supabase project URL |
| `SUPABASE_SECRET_KEY` | secret | Supabase secret key |
| `DAYTONA_API_KEY` | secret | Daytona SDK API key |
| `DAYTONA_API_URL` | env | Daytona API endpoint |
| `LITELLM_MASTER_KEY` | secret | LiteLLM admin key (for `/key/generate`) |
| `LITELLM_PROXY_URL` | env | LiteLLM Cloud Run URL |

### LiteLLM Proxy (Cloud Run)
| Variable | Source | Description |
|----------|--------|-------------|
| `LITELLM_MASTER_KEY` | secret | Admin key |
| `DATABASE_URL` | secret | Supabase Postgres (pooler, port 5432) |
| `ANTHROPIC_API_KEY` | secret | Real Anthropic key |
| `GOOGLE_API_KEY` | secret | Real Google key |
| `OPENAI_API_KEY` | secret | Real OpenAI key |
| `KIMI_API_KEY` | secret | Real Moonshot key |
| `UI_USERNAME` | env | Dashboard login |
| `UI_PASSWORD` | env | Dashboard password |

### Sandbox (Daytona env vars + `.env.token`)
| Variable | Value | Description |
|----------|-------|-------------|
| `OPENAI_BASE_URL` | `${edgeFnUrl}/v1` | Primary LLM path (OpenAI format) |
| `OPENAI_API_KEY` | LiteLLM virtual key | Shared across all providers |
| `ANTHROPIC_BASE_URL` | `${edgeFnUrl}` | Claude native path (pass-through) |
| `ANTHROPIC_API_KEY` | LiteLLM virtual key | Same key |

## Domain

- **meios.ai** — registered on Cloudflare, WHOIS privacy enabled
- **api.meios.ai** — CNAME → `ghs.googlehosted.com`, Cloudflare Proxy enabled (orange cloud)
- SSL: GCP managed certificate (Let's Encrypt) + Cloudflare edge TLS

## Security

See [security.md](security.md) for API key security design and Daytona network constraints.

### Key security properties
- **Real API keys never enter sandboxes** — only LiteLLM virtual keys
- **Virtual key = sandbox scope** — rate limited (60 rpm), budgeted ($5/month), revocable
- **Edge Function has no secrets** — just a network relay, LiteLLM validates everything
- **LiteLLM Dashboard** — audit trail of all requests, spend per key/user/model

## Operations

### Deploy LiteLLM
```bash
cd litellm && gcloud run deploy litellm-proxy \
  --project=xiaozhuo-meios-pi --region=us-central1 --source=. --port=4000
```

### Deploy Auth Gateway
```bash
cd gateway && gcloud run deploy meios-gateway \
  --project=xiaozhuo-meios-pi --region=us-central1 --source=.
```

### Deploy Edge Function
```bash
cd gateway && supabase functions deploy llm-proxy \
  --project-ref exyqukzhnjhbypakhlsp --no-verify-jwt
```

### LiteLLM schema migration
Prisma binary can't reach Supabase pooler directly. Generate SQL then execute via node pg:
```bash
prisma migrate diff --from-empty --to-schema-datamodel schema.prisma --script > tables.sql
node -e "const {Client}=require('pg'); ..." # execute SQL
```
