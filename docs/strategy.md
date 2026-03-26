# meios Strategy

> Updated: 2026-03-25

## Vision

meios is a platform for vertical AI agents (meios). Each meio is a specialized agent
with its own personality, tools, and external service integrations — running in an
isolated sandbox with persistent storage.

The platform is **not locked to wardrobe styling**. The wardrobe meio is the first
vertical; a reader meio (web summarization → Google Docs) is next. The infrastructure
(sandbox, storage, auth, LLM routing) is shared across all meio types.

**Litmus test**: a user tells their personal agent "help me set up a reader meio",
and the agent completes the entire flow — provisioning, configuration, first use —
without human intervention (except one-time email verification).

## Current State (2026-03-25)

### What's working

| Component | Status | Details |
|-----------|--------|---------|
| iOS App | Production | SwiftUI, SSE streaming, image display |
| Auth Gateway | Production | Cloud Run, JWT + API key auth, sandbox provisioning |
| Sandbox (Fly.io) | Production | Per-user Machine, autostop=suspend (1.5-4.5s resume) |
| Persistent Storage | Production | Self-hosted JuiceFS (PG + S3), per-user isolation |
| Image Pipeline | Production | Generation (Gemini) → R2 sync → CDN delivery |
| Collections API | Production | SQLite-backed image grouping |
| LLM Routing | Production | LiteLLM, Kimi K2.5 primary, multi-provider |
| Cold Start | Optimized | 18s cold, 1.5-4.5s suspend resume |

### What's not started

| Item | Priority | Blocks |
|------|----------|--------|
| Credential injection proxy | **P0** | Reader meio (Google Docs API access) |
| Co-located multi-meio routing | **P0** | Multiple meio types per sandbox |
| Reader meio | P1 | Above two items |
| Meio template spec (`meio.json`) | P1 | — |
| Provisioning API | P2 | — |
| Tools dynamic loading | P2 | Custom tools per meio type |
| Isolated sandbox mode | P2 | Security-sensitive meios |
| BYOK (bring your own key) | P2 | — |
| Network egress lockdown | P2 | Public launch security |
| Agent-to-agent sharing | P3 | — |

## Architecture: Meio Template System

### Core concept

A meio template is a git repo (or directory) that defines a meio:

```
meio-reader/
  meio.json           ← metadata: ID, name, tools, secrets, allowed endpoints
  SOUL.md             ← personality definition
  tools.ts            ← tool implementations (meios tools interface)
  config.schema.json  ← user-configurable settings
```

### meio.json example

```json
{
  "id": "reader",
  "name": "Reading Assistant",
  "description": "Summarize web articles to Google Docs",
  "tools": ["summarize", "create_gdoc"],
  "secrets": {
    "GOOGLE_SA_KEY": { "description": "Google Service Account", "required": true }
  },
  "allowedEndpoints": ["docs.googleapis.com", "www.googleapis.com"]
}
```

### Two deployment modes

A user can run multiple meios. Two modes, user chooses per meio:

| | **Co-located** (same sandbox) | **Isolated** (own sandbox) |
|---|---|---|
| How | Multiple sessions in one Fly Machine, each with different SOUL.md / tools | Separate Fly Machine per meio |
| File system | Shared `/persistent/` (meios can see each other's files) | Independent `/persistent/` |
| Cost | Zero marginal cost per meio | 1× Machine rootfs per meio |
| Cold start | Only first meio pays startup cost | Each meio has its own startup |
| Use when | Meios that benefit from shared context, lightweight meios | Security-sensitive, resource-intensive, or fully independent meios |

**Start with co-located mode** — it's almost free (pi-mono already supports multiple
sessions with different system prompts and tools). Reader meio launches this way.
Isolated mode comes later when there's a real need for sandbox-level separation.

**Why co-located works**: pi-mono's `createAgentSession()` accepts per-session `model`,
`tools`, `customTools`, and system prompt (`session.agent.setSystemPrompt()`). The
existing `sessionCache` in gateway.ts already manages multiple concurrent sessions.
Adding a "meio type" dimension is a session-routing change, not an infra change.

### Installation flow (co-located)

1. User or agent calls `POST /api/v1/meios { template: "meio-reader" }`
2. Gateway writes template files to existing sandbox: `/persistent/meios/reader/`
   (`meio.json`, `SOUL.md`, optionally `tools.ts`)
3. Gateway registers the meio in sandbox metadata
4. Next `/chat` request with `{ meioType: "reader" }` loads the reader's SOUL.md and tools
5. Ready — no new Machine, no cold start

### Installation flow (isolated, future)

1. User or agent calls `POST /api/v1/meios { template: "meio-reader", isolated: true }`
2. Gateway creates a new Fly Machine (generic meios image)
3. Machine pulls template → writes to `/persistent/`
4. Ready — separate Machine, separate storage

### Key decisions

- Template is pulled once at creation time, not on every boot. Meios can modify their
  own files (all on JuiceFS persistent storage).
- `tools.ts` dynamic loading is a **nice-to-have**, not a blocker. The existing coding
  tools (read, write, edit, bash) are general-purpose enough for most meios. Custom tools
  can be added later.
- Co-located meios share the same LiteLLM virtual key (same budget). Isolated meios
  get their own key.

## Security: Credential Injection Proxy

### Problem

Meios execute arbitrary code. Real credentials (API keys, service account keys) cannot
live inside the sandbox — environment variables and files are readable by the agent's
bash tool.

### Solution: Gateway HTTP proxy with credential injection

```
meio sends request:
  POST https://docs.googleapis.com/v1/documents
  Authorization: {GOOGLE_TOKEN}     ← placeholder

Gateway (outside sandbox):
  1. Target domain in meio.json allowedEndpoints? → allow
  2. Replace {GOOGLE_TOKEN} placeholder with real value (from secret store)
  3. Forward to external API
  4. Scrub sensitive values from response
  5. Return to meio
```

**Properties**:
- **Generic** — Gateway doesn't need to understand specific APIs, just placeholder
  replacement + domain allowlist + response scrubbing
- **Zero code changes for new services** — just declare secrets and allowedEndpoints
  in meio.json
- **Network egress locked** — sandbox can only reach Gateway, not external APIs directly
  (enforced at Fly.io network level, when enabled for public launch)

### Relationship to LiteLLM

LiteLLM is a specialized credential injection for LLM APIs, with added features
(format translation, multi-provider routing, budgeting, usage tracking).

**Both coexist**:
- LLM calls → LiteLLM (specialized, handles format translation + billing)
- Other external APIs → generic credential injection proxy (lightweight, inject + allowlist)

### Security phases

| Phase | Trust model | Approach |
|-------|------------|----------|
| Now (internal testing) | Trust user and meio | Env var injection |
| Open beta | Trust user, partially trust meio | Gateway proxy + credential injection |
| Public launch | Don't trust meio | Network egress lockdown + phantom tokens + allowlist |

**Phantom tokens** (public launch enhancement): Gateway generates per-session random
tokens bound to localhost + session lifetime. Meio only sees phantom tokens — leaked
tokens are useless outside the sandbox.

## BYOK (Bring Your Own Key)

Users can bring their own API keys instead of using platform LLM quota:

| Scenario | Path | Who pays |
|----------|------|----------|
| Platform LLM | meio → LiteLLM → platform key | Platform (within budget) |
| User BYOK (OpenAI-compatible) | meio → LiteLLM (user's key) | User |
| User BYOK (native API) | meio → credential injection proxy | User |

**Business model insight**: LLM calls will commoditize. meios's value is in the meio
ecosystem (templates), platform capabilities (storage, security, sandbox), and
agent-friendly infrastructure — not in locking users to platform LLM quota.

## Agent-Friendly Platform

### Three-step plan

**Step 1: Developer API** (P1)
- API key auth for developers (no JWT required after initial signup)
- `AGENTS.md` at repo root — agent-readable project metadata
- `llms.txt` at domain root — machine-readable API docs
- OpenAPI spec for all endpoints

**Step 2: One-click provisioning** (P2)
```
POST /api/v1/provision
{ "email": "user@example.com", "plan": "free" }
→ { "api_key": "meios_...", "sandbox_url": "...", "endpoints": {...} }
```

**Step 3: Agent-to-agent sharing** (P3)
- Stylist agent accesses client's wardrobe (with permission)
- Scoped API keys, data sharing policies

## Meio Roadmap

### Wardrobe Meio (current)
- Closet management, outfit generation (Gemini image gen)
- Image collections
- Proactive suggestions (cron heartbeat)

### Reader Meio (next)
- Chrome extension sends web page content → meio
- AI summarization (Kimi K2.5 / Claude)
- Output to Google Docs (via credential injection proxy)
- Prototype exists as local Chrome extension (`meios-easy`), to be migrated to platform

### Future meio ideas
- Food journal meio (photo → nutrition tracking)
- Travel photo meio (organize, tag, create albums)
- Research meio (paper summarization, citation management)

## Implementation Priority

1. **Credential injection proxy** — Gateway HTTP proxy with placeholder replacement +
   domain allowlist. This is the true blocker: reader meio needs Google Docs API access,
   and real credentials cannot live in the sandbox.
2. **Co-located multi-meio routing** — gateway.ts routes `/chat` by meio type to different
   SOUL.md / tools. Lightweight: session-level change, no new infra.
3. **Reader meio** — deploy as second meio type (SOUL.md + coding tools + credential proxy).
   Validates the co-located multi-meio model.
4. **meio.json spec** — formalize the template contract once we have two working meios.
5. **Provisioning API** — `POST /api/v1/meios { template }` creates a meio of any type.
6. **Tools dynamic loading** — load custom tools from `/persistent/` at runtime. Nice-to-have
   for meios that need domain-specific tools beyond coding tools + bash.
7. **Isolated sandbox mode** — 1 user = N Machines. Needed for security-sensitive meios.
8. **BYOK** — user brings their own LLM key.
9. **Network egress lockdown + phantom tokens** — before public launch.

## Design Principles

1. **Platform, not product** — meios provides infrastructure; meios are the products
2. **API-first** — if it doesn't have an API, it doesn't exist for agents
3. **Human gates, agent highways** — humans do one-time setup, agents do everything else
4. **Untrusted sandbox** — all enforcement is server-side; sandbox holds no secrets
5. **Budget as isolation** — worst-case loss is bounded ($5/month per sandbox)
6. **Meio autonomy** — meios can modify their own files, tools, and personality
