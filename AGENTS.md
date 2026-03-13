# AGENTS.md

> Machine-readable project metadata for AI agents.

## Identity

- **Name:** meios
- **Description:** AI wardrobe/outfit assistant platform. Each user gets an isolated sandbox with a personal AI agent.
- **Website:** https://meios.ai
- **API Base URL:** https://api.meios.ai

## Authentication

All API calls require a Bearer token in the `Authorization` header.

Two auth methods:
1. **JWT** — obtained via Supabase Auth (email + password sign-in)
2. **API Key** — generated via `POST /api/v1/keys` (recommended for agents)

```
Authorization: Bearer <jwt_or_api_key>
```

API keys have the prefix `meios_`. They don't expire by default and can be revoked at any time.

## Quick Start for Agents

### 1. Get or create sandbox access

```http
GET /api/v1/sandbox/url
Authorization: Bearer meios_<your_key>

→ {
    "ok": true,
    "data": {
      "url": "https://...signed-url...",
      "expires_at": "2026-03-14T12:00:00Z",
      "port": 18800,
      "endpoints": {
        "chat": "/chat",
        "health": "/health",
        "sessions": "/sessions",
        "closet": "/closet"
      }
    }
  }
```

### 2. Chat with the agent

**Via Gateway (simple):**
```http
POST https://api.meios.ai/chat
Authorization: Bearer meios_<your_key>
Content-Type: application/json

{
  "message": "What should I wear today?",
  "sessionId": "optional-session-id"
}
```

**Via Direct URL (low-latency):**
```http
POST <signed_url>/chat
Content-Type: application/json

{
  "message": "What should I wear today?",
  "sessionId": "optional-session-id"
}
```

### 3. Manage sessions

```http
GET <signed_url>/sessions                    # List sessions
GET <signed_url>/sessions/:id/messages       # Get messages
DELETE <signed_url>/sessions/:id             # Delete session
```

### 4. Access wardrobe

```http
GET <signed_url>/closet                      # Get wardrobe data
```

## API Key Management

```http
POST   /api/v1/keys              # Create a new API key (returns key once)
GET    /api/v1/keys              # List keys (prefixes only)
DELETE /api/v1/keys/:id          # Revoke a key
```

All key management endpoints require authentication (JWT or existing API key).

## SSH Access

For full terminal access to your sandbox:

```http
POST /api/v1/sandbox/ssh
Authorization: Bearer meios_<your_key>
Content-Type: application/json

{"expires_in_minutes": 60}

→ {
    "ok": true,
    "data": {
      "token": "abc123...",
      "host": "ssh.app.daytona.io",
      "command": "ssh abc123...@ssh.app.daytona.io",
      "expires_in_minutes": 60
    }
  }
```

Then connect: `ssh <token>@ssh.app.daytona.io`

## Rate Limits

- **Gateway proxy:** No additional rate limit (passes through to sandbox)
- **LLM calls (sandbox-internal):** 60 requests/min, $5/month budget (free tier)
- **Signed URL:** Expires after 24h, call `GET /api/v1/sandbox/url` to refresh

## Architecture

```
Agent → api.meios.ai (Gateway) → Daytona Sandbox (per-user)
  or
Agent → GET /api/v1/sandbox/url → Direct to Sandbox (signed URL)
```

Each sandbox runs an isolated AI agent with:
- Chat capabilities (wardrobe/outfit assistance)
- Coding tools (read, write, edit, bash)
- Wardrobe tools (closet management)
- LLM access via LiteLLM (rate-limited, budget-controlled)

## Response Format

All endpoints return:
```json
{
  "ok": true,
  "data": { ... }
}
```

Or on error:
```json
{
  "ok": false,
  "error": "Human-readable error message"
}
```

## Source Code

- Repository: https://github.com/supermeio/xiaozhuo-meios-pi
- License: See repository
- Docs: `docs/` directory (architecture, security, model selection, setup)
