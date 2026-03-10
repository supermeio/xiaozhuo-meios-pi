# meios Security

> Updated: 2026-03-11

## API Key Security

### Design Principle

System keys (platform-provided) must **never enter user sandboxes**. The real
`ANTHROPIC_API_KEY` exists only in trusted server-side environments (Cloud Run
env vars, Supabase Edge Function secrets). Sandboxes receive a per-sandbox
token that has no value outside our platform.

### System Key Proxy (implemented)

Each sandbox gets a unique token (`sbx_...`) at provisioning time. When the
pi-agent inside the sandbox makes LLM calls, the Anthropic SDK sends the
sandbox token to our proxy, which validates it and forwards to Anthropic with
the real key.

**Proxy flow:**

```
Sandbox pi-agent
    → ANTHROPIC_BASE_URL (Supabase Edge Function)
    → POST /functions/v1/llm-proxy
      Header: x-api-key: sbx_<sandbox_token>
    → Edge Function:
        1. Query sandboxes table: token = sbx_... AND status = active
        2. If valid → forward to api.anthropic.com with real ANTHROPIC_API_KEY
        3. Stream response back to sandbox
    ← Claude response
```

**Components:**

| Component | Location | Role |
|-----------|----------|------|
| Supabase Edge Function `llm-proxy` | `supabase.co/functions/v1/llm-proxy` | Primary proxy for sandboxes |
| Cloud Run `POST /v1/messages` | `api.meios.ai/v1/messages` | Backup proxy for non-sandbox clients (iOS, etc.) |
| `sandboxes.token` column | Supabase Postgres | Per-sandbox auth token |

**Sandbox env vars (set at provisioning):**

```
ANTHROPIC_BASE_URL=https://<project>.supabase.co/functions/v1/llm-proxy
ANTHROPIC_API_KEY=sbx_<random_hex>
```

The pi-ai SDK reads `ANTHROPIC_BASE_URL` to override the default
`api.anthropic.com` endpoint. A manual `(model as any).baseUrl = process.env.ANTHROPIC_BASE_URL`
is needed after `getModel()` because the SDK hardcodes the base URL in the
model object.

### Why Supabase Edge Function (not Cloud Run)

Daytona sandboxes on Tier 1/2 have **TLS-level egress allowlists** — only
specific domains can be reached. Our domain `api.meios.ai` is not on the list,
but `*.supabase.co` is.

| Domain | Daytona TLS | Notes |
|--------|-------------|-------|
| `api.anthropic.com` | Allowed | AI/ML platform whitelist |
| `api.openai.com` | Allowed | AI/ML platform whitelist |
| `*.supabase.co` | Allowed | Developer tools whitelist |
| `api.meios.ai` | Blocked | Custom domain, not whitelisted |
| `*.run.app` | Blocked | GCP Cloud Run, not whitelisted |

**Upgrade path:** When we upgrade to Daytona Tier 3 ($500 top-up + business
email), full internet access is available. We can then switch `ANTHROPIC_BASE_URL`
to `https://api.meios.ai` and use the Cloud Run proxy directly. The Supabase
Edge Function remains as a fallback.

### Daytona Tier Reference

| Tier | Requirements | Network |
|------|-------------|---------|
| Tier 1 | Email verified | Restricted (allowlist only) |
| Tier 2 | Credit card + $25 + GitHub | Restricted (allowlist only) |
| Tier 3 | Business email + $500 top-up | **Full internet access** |
| Tier 4 | $2000/30d top-up | Full internet access |

`networkAllowList` parameter at sandbox creation is ignored on Tier 1/2.

### BYOK (future)

Users provide their own Anthropic/OpenAI keys. Design:

- Keys encrypted (AES-256-GCM) in Supabase
- Gateway resolves per-user key at request time
- Redacted in all API responses and logs
- Needed when: billing/metering per user, user wants own Claude account

### Industry Reference

| Platform | System Key | BYOK | Key Location |
|----------|-----------|------|-------------|
| Cursor Pro | Pooled, server-proxy | Client-side only | Server / Client |
| Replit Agent | Platform-managed | Encrypted secrets | Server |
| Windsurf | Partial pool | Required for some models | Client |
| openclaw 3.8 | N/A (self-hosted) | SecretRef (env/file/exec) | Local |

Server-side key storage is necessary when agents run on cloud sandboxes.
BYOK keys that stay client-side are simpler but only work for local agents.

## Sandbox Isolation

- Each user gets a dedicated Daytona sandbox (no shared state)
- Sandbox has no access to other users' data or the platform's secrets
- Signed preview URLs expire after 24h, auto-refreshed
- Auto-archive after 7 days of inactivity

## Auth Flow

- iOS → Supabase Auth (email + password) → JWT (ECC P-256)
- Gateway verifies JWT via JWKS endpoint (not legacy HS256)
- JWT `sub` claim maps to `sandboxes.user_id`
