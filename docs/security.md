# meios Security

> Updated: 2026-03-13

## API Key Security

### Design Principle

Real provider API keys (Anthropic, Google, OpenAI, Moonshot) must **never enter user sandboxes**. They exist only in trusted server-side environments:

- **LiteLLM Proxy** (Cloud Run) — holds all real provider keys
- **Supabase Edge Function secrets** — holds `LITELLM_PROXY_URL` only

Sandboxes receive a **LiteLLM virtual key** that has no value outside our platform.

### LiteLLM Virtual Key System

Each sandbox gets a LiteLLM virtual key (`sk-...`) at provisioning time. The key is scoped with:

| Property | Value |
|----------|-------|
| Rate limit | 60 rpm |
| Budget | $5/month |
| Budget reset | Every 30 days |
| Model access | All configured models |

When pi-agent makes LLM calls, the request flows through:

```
Sandbox pi-agent
    → Edge Function (thin relay, *.supabase.co)
    → LiteLLM Proxy (Cloud Run)
        1. Validate virtual key
        2. Check rate limit (60 rpm)
        3. Check budget ($5/month)
        4. Route to provider based on model name
        5. Forward with real provider API key
    ← Provider response
```

### Components

| Component | Role |
|-----------|------|
| Supabase Edge Function `llm-proxy` | Network relay (Daytona can reach `*.supabase.co` but not `*.run.app`) |
| LiteLLM Proxy (Cloud Run) | Auth, rate limit, budget, routing, usage tracking |
| LiteLLM virtual key | Per-sandbox credential, revocable, budget-limited |

### Sandbox env vars (set at provisioning)

```
OPENAI_BASE_URL=https://<project>.supabase.co/functions/v1/llm-proxy
OPENAI_API_KEY=sk-<litellm_virtual_key>
ANTHROPIC_BASE_URL=https://<project>.supabase.co/functions/v1/llm-proxy
ANTHROPIC_API_KEY=sk-<litellm_virtual_key>
```

All providers share the same virtual key — LiteLLM validates it once and routes by model name.

### Key Security Properties

- **Real API keys never enter sandboxes** — only LiteLLM virtual keys
- **Virtual key = sandbox scope** — rate limited, budgeted, revocable
- **Edge Function has no secrets** — just a network relay, LiteLLM validates everything
- **No infrastructure URLs in code** — `LITELLM_PROXY_URL` read from env vars only
- **LiteLLM Dashboard** — audit trail of all requests, spend per key/user/model

### Why Supabase Edge Function (not Cloud Run)

Daytona sandboxes on Tier 1/2 have **TLS-level egress allowlists** — only
specific domains can be reached.

| Domain | Daytona TLS | Notes |
|--------|-------------|-------|
| `*.supabase.co` | Allowed | Developer tools whitelist |
| `api.anthropic.com` | Allowed | AI/ML platform whitelist |
| `api.openai.com` | Allowed | AI/ML platform whitelist |
| `api.meios.ai` | Blocked | Custom domain, not whitelisted |
| `*.run.app` | Blocked | GCP Cloud Run, not whitelisted |

**Upgrade path:** Daytona Tier 3+ ($500 top-up + business email) provides full
internet access. Sandboxes could then call LiteLLM on Cloud Run directly,
eliminating the Edge Function hop.

### Daytona Tier Reference

| Tier | Requirements | Network |
|------|-------------|---------|
| Tier 1 | Email verified | Restricted (allowlist only) |
| Tier 2 | Credit card + $25 + GitHub | Restricted (allowlist only) |
| Tier 3 | Business email + $500 top-up | **Full internet access** |
| Tier 4 | $2000/30d top-up | Full internet access |

### BYOK (future)

Users provide their own API keys. Design:

- Keys encrypted (AES-256-GCM) in Supabase
- LiteLLM supports per-user key override via metadata
- Redacted in all API responses and logs
- Needed when: user wants higher budget or own provider account

## Sandbox Isolation

- Each user gets a dedicated Daytona sandbox (no shared state)
- Sandbox has no access to other users' data or the platform's secrets
- Signed preview URLs expire after 24h, auto-refreshed
- Auto-archive after 7 days of inactivity

## Auth Flow

- iOS → Supabase Auth (email + password) → JWT (ECC P-256)
- Gateway verifies JWT via JWKS endpoint (not legacy HS256)
- JWT `sub` claim maps to `sandboxes.user_id`
