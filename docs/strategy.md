# meios Strategy: User-Friendly + Agent-Friendly

> Updated: 2026-03-13

## Core Goal

meios is a wardrobe/outfit AI agent platform. Our core goal is to be **user-friendly** (humans can use it effortlessly) and **agent-friendly** (other AI agents can programmatically provision and operate meios on behalf of their users).

The litmus test: a user tells their personal agent "help me set up a meios wardrobe assistant", and the agent can complete the entire flow — signup, provisioning, interaction — without human intervention (except one-time email verification).

## Current Architecture (as of 2026-03-13)

```
iOS App → Auth Gateway (Cloud Run) → Daytona Sandbox (per-user)
                                          ↓ LLM calls
                                     Edge Function → LiteLLM → Providers
```

- Each user gets an isolated Daytona sandbox with their own agent instance
- LLM calls are rate-limited ($5/month, 60 rpm) via LiteLLM virtual keys
- Default model: Kimi K2.5 (see [model-selection.md](model-selection.md))
- Full architecture: [architecture.md](architecture.md)

## Three-Step Plan

### Step 1: Open Source + Agent-Friendly for Developers

**Goal:** Developers and their agents can self-host meios or integrate with our platform.

What to do:
- **AGENTS.md** at repo root — Linux Foundation standard for agent-readable project metadata
- **llms.txt** at domain root — machine-readable API documentation
- **Public REST API** with OpenAPI spec — the Auth Gateway already exposes `/chat`, `/sessions`, `/closet`; publish the spec
- **API key auth** — developer creates account once (human, with email verification), gets an API key, agent uses the key for everything after

The repo is already open source. The missing piece is **discoverability** — an agent looking at the repo or domain should immediately know what meios does and how to call it.

### Step 2: One-Click Provisioning API (AgentMail Model)

**Goal:** An external agent can create a meios instance for its user with a single API call.

Inspired by [AgentMail](https://agentmail.to/) — "one API call creates a mailbox". For meios:

```
POST /api/v1/provision
{
  "email": "user@example.com",
  "plan": "free"
}
→ {
    "api_key": "meios_...",
    "sandbox_url": "https://...",
    "endpoints": { "chat": "/chat", "closet": "/closet", ... }
  }
```

**Auth flow for agents:**
1. Human does one-time signup (email + password → Supabase Auth → email verification)
2. Human generates API key from dashboard or iOS app
3. Agent uses API key for all subsequent operations — zero friction, no browser needed

**Why email verification is OK:** It's a one-time human step. The agent doesn't need to handle it. The human signs up, verifies email, hands the API key to their agent, done. This prevents spam/abuse while keeping the agent path frictionless.

### Step 3: Agent-to-Agent Sharing (Future)

**Goal:** Users can share their wardrobe data or agent capabilities with other users' agents.

This is later-stage. Examples:
- Stylist agent accesses client's wardrobe (with permission)
- Friend's agent suggests outfits from shared closets
- Brand agent recommends products based on user's style profile

Requires: permission model, scoped API keys, data sharing policies.

## Agent Direct Sandbox Access

In addition to the Gateway path, we allow agents to access sandboxes directly for lower latency and long-running connections.

### Two Access Paths

| Path | Flow | Best for |
|------|------|----------|
| Gateway (standard) | Agent → `api.meios.ai` → Auth Gateway → Sandbox | Simple calls, mobile, audit trail |
| Direct (fast) | Agent → `GET /api/v1/sandbox/url` → signed URL → Sandbox | Heavy agents, streaming, SSE |

### Direct access flow

```
1. Agent authenticates:
   GET /api/v1/sandbox/url
   Authorization: Bearer <meios-api-key>
   → { "url": "https://...signed-url...", "expires_at": "...", "port": 18800 }

2. Agent calls sandbox directly:
   POST {signed_url}/chat
   POST {signed_url}/closet
   GET  {signed_url}/sessions
   ...

3. Signed URL expires (24h) → agent calls step 1 again
```

### Security analysis

An agent with direct sandbox access can do anything the sandbox allows. The key question: can it bypass LLM budget controls?

| Attack vector | Blocked? | Why |
|---------------|----------|-----|
| Call real provider APIs directly | Yes | Sandbox has no real API keys, only LiteLLM virtual key |
| Tamper with `.env.token` | Useless | LiteLLM validates server-side, fake keys get 401 |
| Call LiteLLM Cloud Run directly | Yes | Daytona Tier 1/2 blocks `*.run.app` |
| Flood through Edge Function | Rate-limited | LiteLLM enforces 60 rpm + $5/month server-side |
| Modify sandbox code to bypass limits | Useless | Rate limit and budget are enforced by LiteLLM, not sandbox |
| Forge another user's virtual key | No | Keys are random, per-sandbox, not guessable |

**Worst case:** Malicious agent maxes out LLM calls at 60 rpm until $5 budget is exhausted. Loss capped at $5/month. Acceptable.

**Key security property:** All rate limiting, budgeting, and auth happen server-side in LiteLLM. The sandbox is untrusted by design — it holds no secrets that matter outside itself.

### Daytona Tier 3+ consideration

If we upgrade to Tier 3+ (full internet access), the sandbox can reach `*.run.app` directly. But:
- LiteLLM virtual key validation still enforced (no master key in sandbox)
- Budget and rate limits still enforced server-side
- This is equivalent to giving users a VPS — their sandbox, their responsibility

## Comparison: meios vs AgentMail

| Dimension | AgentMail | meios (target) |
|-----------|-----------|----------------|
| What it provisions | Email inbox | AI agent sandbox |
| One API call | Creates mailbox | Creates sandbox + agent |
| Agent access | Full mailbox API | Full sandbox API (chat, closet, sessions) |
| Budget control | Per-mailbox | Per-sandbox ($5/month LiteLLM virtual key) |
| Isolation | Per-mailbox | Per-sandbox (Daytona) |

## Implementation Priority

| Priority | Item | Status |
|----------|------|--------|
| P0 | LiteLLM virtual keys + budget | Done |
| P0 | Per-user sandbox isolation | Done |
| P0 | E2E flow (iOS → Gateway → Sandbox → LLM) | Done |
| P1 | API key auth for developers | Not started |
| P1 | `AGENTS.md` + `llms.txt` | Not started |
| P1 | OpenAPI spec for sandbox endpoints | Not started |
| P1 | `GET /api/v1/sandbox/url` (direct access) | Not started |
| P2 | `POST /api/v1/provision` (one-click) | Not started |
| P2 | Developer dashboard (API key management) | Not started |
| P3 | Agent-to-agent sharing | Not started |

## Design Principles

1. **API-first** — if it doesn't have an API, it doesn't exist for agents (Aaron Levie)
2. **Human gates, agent highways** — humans do one-time setup (signup, email verify), agents do everything else via API
3. **Untrusted sandbox** — sandbox holds no secrets that matter; all enforcement is server-side
4. **Budget as isolation** — each sandbox has a hard spending cap; worst-case loss is bounded
5. **Two paths, one platform** — Gateway for convenience, direct access for performance; same underlying sandbox
