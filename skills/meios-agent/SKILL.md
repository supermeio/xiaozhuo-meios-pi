---
name: meios-agent
description: Connect to meios AI wardrobe assistant via API key. Use when the user wants to set up meios, connect an agent to meios, manage their wardrobe via meios, or says things like "connect to meios", "set up meios", "use meios", "meios wardrobe", "meios agent".
---

# meios Agent Integration

Connect any AI agent to a user's meios wardrobe assistant sandbox.

## Prerequisites

- A meios API key (`meios_` prefix). Get one from:
  - iOS app: Settings > API Keys > tap "+"
  - API: `POST https://api.meios.ai/api/v1/keys` with JWT auth

## Step 1: Get Sandbox URL

```bash
curl -s https://api.meios.ai/api/v1/sandbox/url \
  -H "Authorization: Bearer $MEIOS_API_KEY"
```

Response:
```json
{
  "ok": true,
  "data": {
    "url": "https://18800-xxxxx.daytonaproxy01.net",
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

Save the `url` — this is the direct sandbox access URL (expires in 24h).

**Verify:**
```bash
curl -s "$SANDBOX_URL/health"
# Expected: {"ok":true,"data":{"uptime":...,"model":"kimi-k2.5",...}}
```

## Step 2: Chat with the Agent

```bash
curl -s "$SANDBOX_URL/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"What should I wear to a job interview?"}'
```

Response:
```json
{
  "ok": true,
  "data": {
    "reply": "For a job interview, I'd recommend...",
    "sessionId": "s-1773398496775-hmvfmd"
  }
}
```

To continue a conversation, pass the `sessionId` back:
```bash
curl -s "$SANDBOX_URL/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"What about shoes?","sessionId":"s-1773398496775-hmvfmd"}'
```

## Step 3: Other Operations

### List Sessions
```bash
curl -s "$SANDBOX_URL/sessions"
```

### Get Session History
```bash
curl -s "$SANDBOX_URL/sessions/$SESSION_ID/messages"
```

### Delete Session
```bash
curl -s -X DELETE "$SANDBOX_URL/sessions/$SESSION_ID"
```

### View Wardrobe
```bash
curl -s "$SANDBOX_URL/closet"
```

## Step 4: SSH into Sandbox

For full terminal access (install packages, edit files, run scripts):

```bash
# Create SSH token (expires in 60 minutes by default)
SSH_DATA=$(curl -s -X POST https://api.meios.ai/api/v1/sandbox/ssh \
  -H "Authorization: Bearer $MEIOS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"expires_in_minutes": 60}')

echo "$SSH_DATA" | python3 -m json.tool
```

Response:
```json
{
  "ok": true,
  "data": {
    "token": "abc123...",
    "host": "ssh.app.daytona.io",
    "command": "ssh abc123...@ssh.app.daytona.io",
    "expires_in_minutes": 60
  }
}
```

Connect:
```bash
SSH_CMD=$(echo "$SSH_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['command'])")
$SSH_CMD
```

Once inside the sandbox:
- Workspace: `/home/daytona/meios/workspace/`
- Server code: `/home/daytona/meios/server/`
- Gateway running on port 18800
- Node.js 20, npm available

**Use cases:**
- Install additional tools or packages
- Inspect/modify files in the wardrobe workspace
- Debug server logs
- Run custom scripts

**Token expiry:** Default 60 minutes. Request a longer duration with `expires_in_minutes`. When expired, create a new token.

## Three Access Paths

| Path | When to use |
|------|-------------|
| **Direct URL** (Step 2-3) | Low latency HTTP, streaming, heavy agent usage |
| **SSH** (Step 4) | Full terminal access, file editing, package install |
| **Via Gateway** | Simple calls, no URL management |

Gateway path — same endpoints, just use `https://api.meios.ai` as base URL with auth header:
```bash
curl -s https://api.meios.ai/chat \
  -H "Authorization: Bearer $MEIOS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"hi"}'
```

## URL Expiry

The direct sandbox URL expires after **24 hours**. When it expires:
1. Requests will fail (connection refused or 403)
2. Call Step 1 again to get a fresh URL
3. Resume with the new URL

The Gateway path (`api.meios.ai`) handles URL refresh automatically.

## Response Format

All endpoints return:
```json
{"ok": true, "data": { ... }}
```
or on error:
```json
{"ok": false, "error": "Human-readable message"}
```

## Rate Limits

- LLM calls (inside sandbox): **60 req/min**, **$5/month budget** (free tier)
- Sandbox API calls: no additional rate limit
- Signed URL: **24h TTL**, refresh via `GET /api/v1/sandbox/url`

## API Key Management

```bash
# Create key
curl -s -X POST https://api.meios.ai/api/v1/keys \
  -H "Authorization: Bearer $MEIOS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-agent"}'

# List keys (prefixes only)
curl -s https://api.meios.ai/api/v1/keys \
  -H "Authorization: Bearer $MEIOS_API_KEY"

# Revoke key
curl -s -X DELETE https://api.meios.ai/api/v1/keys/$KEY_ID \
  -H "Authorization: Bearer $MEIOS_API_KEY"
```

## Full Example: Agent Script

```bash
#!/bin/bash
# Connect to meios and have a conversation

MEIOS_API_KEY="meios_your_key_here"

# 1. Get sandbox URL
SANDBOX_URL=$(curl -s https://api.meios.ai/api/v1/sandbox/url \
  -H "Authorization: Bearer $MEIOS_API_KEY" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['url'])")

echo "Sandbox: $SANDBOX_URL"

# 2. Verify connection
curl -s "$SANDBOX_URL/health" | python3 -m json.tool

# 3. Start conversation
REPLY=$(curl -s "$SANDBOX_URL/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"What should I wear today? It is sunny and 22°C."}')

echo "$REPLY" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print(d['reply'])"
SESSION=$(echo "$REPLY" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['sessionId'])")

# 4. Follow-up
curl -s "$SANDBOX_URL/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Something more casual?\",\"sessionId\":\"$SESSION\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['reply'])"
```

## OpenAPI Spec

Full API specification: https://github.com/supermeio/xiaozhuo-meios-pi/blob/main/openapi.yaml

## More Info

- Architecture: https://github.com/supermeio/xiaozhuo-meios-pi/blob/main/docs/architecture.md
- Security: https://github.com/supermeio/xiaozhuo-meios-pi/blob/main/docs/security.md
- AGENTS.md: https://github.com/supermeio/xiaozhuo-meios-pi/blob/main/AGENTS.md
