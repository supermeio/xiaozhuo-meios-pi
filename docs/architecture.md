# meios Architecture

> Updated: 2026-03-10

## Overview

meios is a lightweight vertical AI agent platform for wardrobe/outfit assistance. Each user gets an isolated sandbox with their own agent instance.

## Architecture Diagram

```
┌──────────┐     HTTPS      ┌──────────────┐    CNAME     ┌──────────────────┐
│ iOS App  │ ──────────────▶ │  Cloudflare  │ ──────────▶  │  GCP Cloud Run   │
│ (Meio)   │  api.meios.ai  │     DNS       │              │  Auth Gateway    │
└──────────┘                 └──────────────┘              └────────┬─────────┘
     │                                                         │   │   │
     │ login/signup                              JWKS verify   │   │   │
     ▼                                                         │   │   │
┌──────────────────┐◀──────────────────────────────────────────┘   │   │
│  Supabase Auth   │                                               │   │
└──────────────────┘                                               │   │
┌──────────────────┐◀──────────────────────────────────────────────┘   │
│  Supabase PG     │  query sandboxes                                  │
└──────────────────┘                                                   │
                              proxy (signed URL)                       │
     ┌─────────────────────────────────┐◀──────────────────────────────┘
     │     Daytona Sandbox (per-user)  │
     │  ┌───────────────────────────┐  │
     │  │  meios gateway (:18800)   │  │
     │  │  pi-agent + Claude 4.5    │  │
     │  └───────────────────────────┘  │
     └─────────────────────────────────┘
```

## Components

### iOS App (Meio)
- SwiftUI, iOS 17+, built with xcodegen
- Supabase Auth SDK (email + password)
- API endpoint: `https://api.meios.ai`

### Auth Gateway (this repo)
- Hono + TypeScript on GCP Cloud Run (us-central1)
- JWT verification via Supabase JWKS (ECC P-256)
- Per-user sandbox routing with signed URL management
- Auto-provisions sandbox for new users on first request

### Supabase
- Auth: ECC P-256 JWT, JWKS verification
- Postgres: `sandboxes` table (user_id → daytona_id, signed_url)

### Daytona Sandbox (per-user)
- Image: `node:20-slim`, 2 CPU, 2GB RAM, 5GB disk
- Auto-provision: clone repo → npm install → start gateway
- Gateway port: 18800
- Signed URL: 24h TTL, auto-refresh 1h before expiry, retry on 401
- Auto-archive after 7 days of inactivity

### meios Server (runs inside sandbox)
- Repo: [supermeio/xiaozhuo-meios-pi](https://github.com/supermeio/xiaozhuo-meios-pi)
- pi-agent + Claude Haiku 4.5
- Unified response envelope: `{ ok, data, error }`

## Request Flow

```
iOS → api.meios.ai (Cloudflare DNS)
    → Cloud Run Auth Gateway
        → Verify JWT via JWKS
        → Lookup sandbox signed URL in Postgres (auto-provision if new user)
        → Proxy to Daytona sandbox
            → meios gateway → pi-agent → Claude Haiku 4.5
        ← { ok, data, error }
    ← Response to iOS
```

## API Endpoints (meios gateway)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/chat` | Send a message |
| `GET` | `/health` | Health check |
| `GET` | `/sessions` | List sessions |
| `GET` | `/sessions/:id/messages` | Get session messages |
| `DELETE` | `/sessions/:id` | Delete a session |
| `GET` | `/closet` | Get wardrobe data |
| `GET` | `/cron` | Cron tasks |

## Environment Variables (Cloud Run)

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Supabase secret key (server-side) |
| `DAYTONA_API_KEY` | Daytona SDK API key |
| `DAYTONA_API_URL` | Daytona API endpoint |
| `ANTHROPIC_API_KEY` | Passed to new sandboxes for Claude access |

## Domain

- **meios.ai** — registered on Cloudflare, WHOIS privacy enabled
- **api.meios.ai** — CNAME → `ghs.googlehosted.com` → Cloud Run domain mapping
- SSL: GCP managed certificate (Let's Encrypt, auto-provisioned)
