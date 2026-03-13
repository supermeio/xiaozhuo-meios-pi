---
name: meios-agent
description: Connect to meios AI wardrobe assistant via API key. Use when the user wants to set up meios, connect an agent to meios, manage their wardrobe via meios, or says things like "connect to meios", "set up meios", "use meios", "meios wardrobe", "meios agent".
---

# meios Agent Integration

meios is an AI wardrobe/outfit assistant. Each user gets an isolated sandbox. You interact with it via API.

## Getting an API Key

You need a meios API key (`meios_` prefix) from the user. Existing keys only show prefixes and **cannot be copied** — the user must create a new one.

Ask the user to do this:

> 1. Open the **Meio** app on your iPhone
> 2. Tap the **gear icon** (top right) to open Settings
> 3. Tap **API Keys**
> 4. Tap **+** (top right) to create a new key
> 5. A full key appears once — tap the **copy icon** next to it
> 6. Paste the key back here

The key looks like: `meios_6c4334cc88b796bdecfc88f33259d00e`

If the user already has a key saved, they can use that directly.

## Quick Start (3 commands)

```bash
MEIOS_API_KEY="meios_..."  # from the step above

# 1. Chat via gateway (simplest — no setup needed)
curl -s https://api.meios.ai/chat \
  -H "Authorization: Bearer $MEIOS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"What should I wear today?"}'

# → {"ok":true,"data":{"reply":"...","sessionId":"s-xxx"}}
```

That's it. If you only need to chat, stop here.

## Choose Your Access Path

| Path | Auth | Latency | Use when |
|------|------|---------|----------|
| **Gateway** | API key in header | Normal | Simple chat, sessions, closet |
| **Direct URL** | None (URL is the auth) | Low | Streaming, high-frequency calls |
| **SSH** | Token-based | N/A | Terminal access, file ops, install packages |

## Path A: Gateway (Simplest)

All sandbox endpoints available at `https://api.meios.ai` with API key auth.

```bash
# Chat (with session continuity)
curl -s https://api.meios.ai/chat \
  -H "Authorization: Bearer $MEIOS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"What about shoes?","sessionId":"s-xxx"}'

# List sessions
curl -s https://api.meios.ai/sessions \
  -H "Authorization: Bearer $MEIOS_API_KEY"

# Get session messages
curl -s https://api.meios.ai/sessions/SESSION_ID/messages \
  -H "Authorization: Bearer $MEIOS_API_KEY"

# Delete session
curl -s -X DELETE https://api.meios.ai/sessions/SESSION_ID \
  -H "Authorization: Bearer $MEIOS_API_KEY"

# View wardrobe
curl -s https://api.meios.ai/closet \
  -H "Authorization: Bearer $MEIOS_API_KEY"
```

No URL management needed. Gateway handles sandbox provisioning and URL refresh automatically.

## Path B: Direct URL (Low Latency)

Get a signed URL, then call the sandbox directly — no auth header needed.

```bash
# 1. Get sandbox URL (24h TTL, auto-provisions if needed)
SANDBOX_URL=$(curl -s https://api.meios.ai/api/v1/sandbox/url \
  -H "Authorization: Bearer $MEIOS_API_KEY" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['url'])")

# 2. Verify
curl -s "$SANDBOX_URL/health"
# → {"ok":true,"data":{"model":"kimi-k2.5","version":"0.1.0",...}}

# 3. Chat directly (no auth header — the URL itself is the credential)
curl -s "$SANDBOX_URL/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"What should I wear today?"}'
```

Same endpoints as Gateway (`/chat`, `/sessions`, `/closet`, etc.) — just use `$SANDBOX_URL` as base.

**URL expires after 24h.** When requests fail, call `GET /api/v1/sandbox/url` again.

## Path C: SSH (Full Terminal)

For installing packages, editing files, running scripts, or debugging.

```bash
# 1. Create SSH token (default: 60 min)
SSH_CMD=$(curl -s -X POST https://api.meios.ai/api/v1/sandbox/ssh \
  -H "Authorization: Bearer $MEIOS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"expires_in_minutes":60}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['command'])")

# 2. Connect
$SSH_CMD
```

Inside the sandbox:
```
/home/daytona/meios/           # Project root
├── workspace/                 # Wardrobe data
├── server/                    # Agent server code
└── .env.token                 # LLM credentials (managed by platform)
```

Node.js 20 and npm are available. Token expires after the requested duration — create a new one when needed.

## Response Format

All endpoints return:
```json
{"ok": true, "data": { ... }}        // success
{"ok": false, "error": "message"}    // error
```

## Rate Limits

| Resource | Limit |
|----------|-------|
| LLM calls (inside sandbox) | 60 req/min, $5/month (free tier) |
| Sandbox API calls | No limit |
| Direct URL TTL | 24 hours |
| SSH token TTL | Configurable (default 60 min) |

## API Key Management

Users create API keys from the iOS app (Settings > API Keys) or via API:

```bash
# Create (full key shown only once — store it)
curl -s -X POST https://api.meios.ai/api/v1/keys \
  -H "Authorization: Bearer $MEIOS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-agent"}'

# List (prefixes only)
curl -s https://api.meios.ai/api/v1/keys \
  -H "Authorization: Bearer $MEIOS_API_KEY"

# Revoke
curl -s -X DELETE https://api.meios.ai/api/v1/keys/KEY_ID \
  -H "Authorization: Bearer $MEIOS_API_KEY"
```

## Full Example

```bash
#!/bin/bash
# End-to-end: connect to meios, chat, follow up, then SSH in
MEIOS_API_KEY="meios_your_key_here"

# Chat via gateway
REPLY=$(curl -s https://api.meios.ai/chat \
  -H "Authorization: Bearer $MEIOS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"What should I wear today? Sunny, 22°C."}')
echo "$REPLY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['reply'])"
SESSION=$(echo "$REPLY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['sessionId'])")

# Follow-up in same session
curl -s https://api.meios.ai/chat \
  -H "Authorization: Bearer $MEIOS_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Something more casual?\",\"sessionId\":\"$SESSION\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['reply'])"

# SSH in to inspect workspace
SSH_CMD=$(curl -s -X POST https://api.meios.ai/api/v1/sandbox/ssh \
  -H "Authorization: Bearer $MEIOS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"expires_in_minutes":30}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['command'])")
echo "SSH: $SSH_CMD"
```

## Reference

- OpenAPI spec: https://github.com/supermeio/xiaozhuo-meios-pi/blob/main/openapi.yaml
- Architecture: https://github.com/supermeio/xiaozhuo-meios-pi/blob/main/docs/architecture.md
- Security: https://github.com/supermeio/xiaozhuo-meios-pi/blob/main/docs/security.md
- AGENTS.md: https://github.com/supermeio/xiaozhuo-meios-pi/blob/main/AGENTS.md
