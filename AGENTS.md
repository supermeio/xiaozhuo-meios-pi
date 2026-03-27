# AGENTS.md

> Machine-readable project metadata for AI agents.

## Identity

- **Name:** meios
- **Description:** Platform for vertical AI agents (meios). Each meio is a specialized agent with its own personality, tools, and external service integrations — running in an isolated sandbox with persistent storage.
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

### 1. Create an API key

```http
POST /api/v1/keys
Authorization: Bearer <jwt>
Content-Type: application/json

{"name": "my-agent"}

→ { "ok": true, "data": { "id": "...", "key": "meios_abc123...", ... } }
```

Store the key securely — it's returned only once.

### 2. Chat with a meio

All requests go through the gateway. The gateway auto-provisions a sandbox on first use.

```http
POST /chat
Authorization: Bearer meios_<your_key>
Content-Type: application/json

{
  "message": "What should I wear today?",
  "meioType": "wardrobe",
  "sessionId": "optional-session-id"
}

→ { "ok": true, "data": { "reply": "...", "sessionId": "s-1234-abc" } }
```

**meioType** selects which meio to talk to. Available types depend on what the user has provisioned. Omit for the default meio.

**Streaming**: Add `Accept: text/event-stream` header to get SSE streaming responses.

### 3. List available meios

```http
GET /meios
Authorization: Bearer meios_<your_key>

→ { "ok": true, "data": { "meios": [
    { "type": "default", "name": "Default", "hasSoul": true },
    { "type": "wardrobe", "name": "穿搭助手", "hasSoul": true },
    { "type": "reader", "name": "Reading Assistant", "hasSoul": true }
  ] } }
```

### 4. Provision a meio

```http
POST /api/v1/meios
Authorization: Bearer meios_<your_key>
Content-Type: application/json

{ "template": "reader" }

→ {
    "ok": true,
    "data": {
      "id": "reader",
      "name": "Reading Assistant",
      "version": "0.1.0",
      "installed": true,
      "ready": false,
      "missingCredentials": [
        { "service": "google", "description": "Google Service Account key (JSON)", "required": true,
          "setupUrl": "https://meios.ai/docs/setup/google-sa" }
      ]
    }
  }
```

If `ready` is false, configure the missing credentials (step 5), then the meio is ready to use.

Available templates: `wardrobe`, `reader`.

### 5. Manage credentials (for meios that need external APIs)

Some meios need external service credentials (e.g., reader needs Google Docs access). Credentials are stored encrypted and never exposed to the sandbox.

```http
PUT /api/v1/credentials/google
Authorization: Bearer meios_<your_key>
Content-Type: application/json

{ "credential": { <service-account-key.json contents> }, "label": "My Google SA" }
```

**Security**: Never paste credentials into chat. Use the credentials API directly.

## API Reference

### Gateway Endpoints (api.meios.ai)

#### Health
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/ping` | None | Gateway health check |

#### API Keys
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/keys` | Bearer | Create API key (returns full key once) |
| GET | `/api/v1/keys` | Bearer | List keys (prefixes only) |
| DELETE | `/api/v1/keys/:id` | Bearer | Revoke key |

#### Credentials
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| PUT | `/api/v1/credentials/:service` | Bearer | Store encrypted credential |
| GET | `/api/v1/credentials` | Bearer | List credentials (metadata only) |
| DELETE | `/api/v1/credentials/:service` | Bearer | Remove credential |

#### Meio Provisioning
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/meios` | Bearer | Provision a meio from template |
| GET | `/api/v1/meios` | Bearer | List provisioned meios |
| DELETE | `/api/v1/meios/:type` | Bearer | Remove a meio |

#### Sandbox
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/sandbox/url` | Bearer | Get direct sandbox URL (auto-provisions) |

### Sandbox Endpoints (proxied through gateway)

All sandbox endpoints are accessible via `https://api.meios.ai/<path>` — the gateway proxies to the user's sandbox.

#### Chat & Sessions
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/chat` | Bearer | Send message. Body: `{ message, meioType?, sessionId? }` |
| GET | `/meios` | Bearer | List available meio types |
| GET | `/sessions` | Bearer | List sessions with previews |
| GET | `/sessions/:id/messages` | Bearer | Get session message history |
| DELETE | `/sessions/:id` | Bearer | Delete session |

#### Images & Collections
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/images` | Bearer | List all registered images |
| GET | `/collections` | Bearer | List collections with cover images |
| POST | `/collections` | Bearer | Create collection. Body: `{ name, description? }` |
| GET | `/collections/:id` | Bearer | Get collection + images |
| DELETE | `/collections/:id` | Bearer | Delete collection |
| POST | `/collections/:id/images` | Bearer | Add image. Body: `{ imagePath }` |
| DELETE | `/collections/:id/images/:imgId` | Bearer | Remove image from collection |

#### Wardrobe
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/closet` | Bearer | List wardrobe items |

#### File System
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/fs?path=<dir>` | Bearer | List directory contents |
| GET | `/files/<path>` | Bearer | Read/download file |
| PUT | `/files/<path>` | Bearer | Write/update file (max 512 KB) |

#### System
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Sandbox health check |
| GET | `/cron` | Bearer | List cron tasks |

## Meio Types

A meio type determines which personality (SOUL.md) and tools the agent uses.

| Type | Description | Custom Tools | Needs Credentials |
|------|-------------|-------------|-------------------|
| `default` | General-purpose assistant | None (coding tools only) | No |
| `wardrobe` | Closet management + outfit generation | 9 wardrobe tools | No |
| `reader` | Web article summarization → Google Docs | None (coding tools only) | Yes (Google SA) |

Pass `meioType` in the `/chat` request body to select a meio. Each meio has its own personality but shares the user's session history and memory.

## Response Format

All endpoints return:
```json
{ "ok": true, "data": { ... } }
```

On error:
```json
{ "ok": false, "error": "Human-readable error message" }
```

## Architecture

```
Agent → api.meios.ai (Gateway, Cloud Run)
  ├─ Auth (JWT / API Key)
  ├─ Credential storage (AES-256-GCM encrypted)
  ├─ Proxy → Fly.io Sandbox (per-user, isolated)
  │    ├─ AI Agent (multi-meio: wardrobe, reader, etc.)
  │    ├─ Coding tools (read, write, edit, bash)
  │    ├─ Custom tools (per meio type)
  │    ├─ Persistent storage (JuiceFS)
  │    └─ LLM access via LiteLLM
  └─ Credential proxy (sandbox → external APIs)
```

## Rate Limits

- **Gateway proxy:** No additional rate limit
- **LLM calls (sandbox-internal):** 60 req/min, $5/month budget (free tier)

## Further Reading

- OpenAPI spec: `openapi.yaml` in this repository
- Architecture: `docs/architecture.md`
- Security: `docs/security.md`
- Meio template spec: `docs/meio-json-spec.md`
- Source: https://github.com/supermeio/xiaozhuo-meios-pi
