# Security Best Practices Report

Updated: 2026-03-11

## Executive Summary

This codebase has a strong high-level goal of keeping the real `ANTHROPIC_API_KEY`
out of user sandboxes, but the current implementation still gives untrusted end
users a practical path to extract a reusable proxy credential and abuse the
platform-paid LLM proxy. The most important issues are:

1. The public `/chat` API wires end-user prompts straight into a general-purpose
   coding agent with shell and file-edit tools.
2. The sandbox LLM token is a long-lived bearer secret stored in plaintext and
   accepted from the public internet by the proxy.
3. The request-body protections are not effective against chunked requests, so
   authenticated users or leaked-token holders can still force large bodies into
   memory.
4. Client-controlled `sessionId` values are resolved directly as filesystem
   paths, allowing path traversal outside the sessions directory.

## Critical

### SEC-001: End users get shell/file-tool access through the public chat API

- Severity: Critical
- Location:
  - `server/src/gateway.ts:229-236`
  - `server/src/gateway.ts:307-319`
  - `gateway/src/sandbox.ts:84-87`
- Evidence:
  - `createAgentSession({ ..., tools: codingTools, ... })`
  - `POST /chat` passes the raw user-supplied `message` directly into that agent
  - sandbox env includes `ANTHROPIC_API_KEY: sandboxToken`
- Impact:
  - Any authenticated user can prompt the agent to read files, edit files, or
    run shell commands inside their sandbox. In practice that means they can
    extract the sandbox token from environment variables, inspect system prompt
    files, mutate local state, and repurpose the product into a general shell on
    paid infrastructure rather than a wardrobe assistant.
- Fix:
  - Do not expose `codingTools` to untrusted product users.
  - Replace them with a narrowly-scoped tool set that only supports the intended
    wardrobe actions.
  - If self-modification is intentionally required, gate it behind a privileged
    operator-only route and add explicit allowlists for commands and paths.
- Mitigation:
  - Strip sensitive env vars before starting the end-user-facing agent process.
  - Add outbound request quotas and per-user abuse detection immediately.

## High

### SEC-002: Sandbox proxy token is a public-internet bearer credential with no expiry and plaintext storage

- Severity: High
- Location:
  - `gateway/src/sandbox.ts:72-87`
  - `gateway/src/db.ts:60-70`
  - `gateway/supabase/schema.sql:14`
  - `gateway/supabase/functions/llm-proxy/index.ts:36-62`
- Evidence:
  - Token is generated once and injected into sandbox env as `ANTHROPIC_API_KEY`
  - Database stores `token text`
  - Proxy authenticates only `x-api-key`
  - Existing TODO explicitly notes missing hashing and expiry
- Impact:
  - Once a user, prompt injection, log leak, or database leak reveals a token,
    that token can be replayed from anywhere on the internet until the sandbox is
    manually deactivated. This contradicts the claim that the sandbox token "has
    no value outside our platform" and creates a direct billing-abuse path.
- Fix:
  - Treat the sandbox token like a real secret: store only a SHA-256 hash,
    add an expiry column, rotate automatically, and bind usage to a specific
    sandbox/user lifecycle.
  - Consider short-lived signed requests instead of a static bearer token.
- Mitigation:
  - Rotate all existing sandbox tokens after rollout.
  - Log and alert on proxy usage after sandbox archival or unusual request rates.

### SEC-003: The primary Supabase Edge LLM proxy has no effective rate limit

- Severity: High
- Location:
  - `gateway/src/config.ts:22-24`
  - `gateway/src/sandbox.ts:84-87`
  - `gateway/supabase/functions/llm-proxy/index.ts:64-66`
- Evidence:
  - Sandboxes are configured to use the Supabase Edge Function as their default
    `ANTHROPIC_BASE_URL`
  - The Edge Function comment explicitly states rate limiting is not implemented
- Impact:
  - The only working path for Daytona Tier 1/2 sandboxes is the one with no real
    throttling. A leaked token therefore maps almost directly to uncapped
    Anthropic spend.
- Fix:
  - Enforce a real per-sandbox quota in the Edge Function using a shared store
    (Postgres, Redis, KV, or Supabase rate limiting features).
  - Reject or slow down abusive callers before forwarding to Anthropic.
- Mitigation:
  - Add coarse project-level limits at the edge/load balancer while building a
    proper per-token limiter.

### SEC-004: Request size checks happen after buffering the body, so large chunked requests can still exhaust memory

- Severity: High
- Location:
  - `gateway/src/llm-proxy.ts:53-85`
  - `gateway/supabase/functions/llm-proxy/index.ts:68-111`
  - `server/src/gateway.ts:99-104`
  - `gateway/src/proxy.ts:81-83`
- Evidence:
  - Both LLM proxies only enforce size early when `Content-Length` is present
  - When it is absent, they call `req.text()` / `c.req.text()` first and only
    then compare body size
  - `/chat` buffers the full request body with no size limit at all
- Impact:
  - An authenticated user or leaked-token holder can omit `Content-Length` and
    stream a very large body, forcing the process to allocate memory before any
    rejection happens. This is a straightforward denial-of-service path against
    both the shared gateway and the per-user sandbox.
- Fix:
  - Enforce byte limits while streaming, before full buffering.
  - Add explicit body caps to `/chat` and to the gateway-to-sandbox forwarder.
  - Prefer rejecting requests based on incoming stream length, not string length.
- Mitigation:
  - Put a strict request-size limit at Cloud Run / CDN / reverse proxy level.

## Medium

### SEC-005: `sessionId` is used as a filesystem path without validation

- Severity: Medium
- Location:
  - `server/src/gateway.ts:211-241`
  - `server/src/gateway.ts:307-319`
- Evidence:
  - `const sessDir = sessionId ? resolve(SESSIONS_DIR, sessionId) : ...`
  - `sessionId` comes directly from the JSON body of `POST /chat`
- Impact:
  - A caller can supply values such as `../../workspace/pwn` or `/tmp/pwn` and
    make the server create or reuse session storage outside
    `.meios-agent/sessions`. That enables arbitrary directory creation and
    session-state writes in unintended locations inside the sandbox.
- Fix:
  - Accept only server-generated session IDs (for example `^s-[0-9]+-[a-z0-9]+$`)
    and reject anything else.
  - After resolution, verify the final path still stays under `SESSIONS_DIR`.
- Mitigation:
  - Generate session IDs exclusively server-side and stop accepting a raw pathish
    `sessionId` from clients.

### SEC-006: The local Daytona helper script violates the platform's own secret-isolation model

- Severity: Medium
- Location:
  - `server/src/daytona.ts:29-35`
  - `server/src/daytona.ts:84-86`
  - `server/src/daytona.ts:101-106`
  - `server/src/daytona.ts:143-149`
  - `server/src/daytona.ts:161-163`
- Evidence:
  - Script reads the real Anthropic key, injects it into sandbox env, uploads
    `.meios-agent/auth.json`, stores preview tokens on disk, and prints SSH
    access tokens to stdout
- Impact:
  - If this helper is ever used outside a throwaway local test, it defeats the
    repo's main security guarantee and increases the chance of secret leakage via
    local files, terminal logs, or copied scripts.
- Fix:
  - Keep this script clearly separated as a local-only POC or delete it.
  - If it must remain, scrub secrets from env/files/logs and use the same
    sandbox-token proxy flow as production.

### SEC-007: `gateway` currently ships a vulnerable `hono` release

- Severity: Medium
- Location:
  - `gateway/package-lock.json` (`hono` 4.12.6)
- Evidence:
  - `npm audit --omit=dev` reports [GHSA-v8w9-8mx6-g223](https://github.com/advisories/GHSA-v8w9-8mx6-g223)
  - Installed version is `4.12.6`, advisory affects `<4.12.7`
- Impact:
  - The known issue is prototype pollution through `parseBody({ dot: true })`.
    I did not find a direct `parseBody()` call in this repo, so this is not a
    proven exploit here, but it is still an avoidable vulnerable dependency in a
    public-facing service.
- Fix:
  - Upgrade `hono` to `4.12.7` or newer and redeploy.

## Lower-Severity Notes

- `gateway/src/auth.ts:37-38` returns raw JWT verification errors to the client.
  That is not a direct break, but generic auth failures are safer.
- `gateway/src/index.ts:13-17` uses permissive CORS by default. This is less
  important for bearer-token APIs than for cookie auth, but production should
  still pin allowed origins deliberately.

## Recommended Order

1. Remove `codingTools` from the public wardrobe chat path.
2. Redesign sandbox token handling: hash, expire, rotate, and rate-limit.
3. Add true streaming body limits at every public POST boundary.
4. Validate `sessionId` and constrain all session paths under `SESSIONS_DIR`.
5. Retire or isolate the local Daytona POC script.
6. Patch `hono` to `4.12.7+`.
