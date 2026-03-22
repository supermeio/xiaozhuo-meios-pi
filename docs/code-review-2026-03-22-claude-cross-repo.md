# Code Review: Cross-Repo Security Audit

**Date:** 2026-03-22
**Reviewer:** Claude (Opus 4.6)
**Scope:** xiaozhuo-meios-pi (server) + xiaozhuo-meios-ios (iOS client)
**Trigger:** Post-merge review after PR #13 (auto-stop Fly.io machines) and PR #14 (remove Daytona SDK)

---

## Summary

No hardcoded secrets or API keys found in either repo's source code or git history. The Supabase `sb_publishable_` key in Info.plist is the new (2025-06) public key format — safe for client-side use. Overall code quality is solid: parameterized SQL, proper Keychain usage, correct path traversal defenses.

Two information disclosure issues were found and fixed in this review. Several medium-priority architectural items remain for future work.

---

## Fixed in This Review

### 1. Tailscale tailnet ID exposed in public repo (HIGH)

**File:** `xiaozhuo-meios-ios/Meio/Info.plist`
**Was:** ATS exception for `openclaw-011.tail49ccd0.ts.net` — leaked private Tailscale network name and machine hostname.
**Fix:** Replaced domain-specific exception with `NSAllowsLocalNetworking: true`, which permits HTTP for local network development without revealing infrastructure details.

### 2. Internal IP compiled into release binary (MEDIUM)

**File:** `xiaozhuo-meios-ios/Meio/Services/APIEnvironment.swift`
**Was:** `case dev` with `http://192.168.31.101:18800` was part of the enum in all builds, exposing local network topology in the release binary.
**Fix:** Wrapped entire `.dev` case and all its switch branches in `#if DEBUG`. The dev environment is now completely stripped from release builds.

---

## Open Items

### Server (xiaozhuo-meios-pi)

| Priority | Issue | Location | Notes |
|----------|-------|----------|-------|
| **MED-HIGH** | Shared `GATEWAY_SECRET` across all sandboxes | `server/src/gateway.ts:178-193` | One sandbox compromise → access to all. Code has TODO to upgrade to per-user JWT |
| **MEDIUM** | Auth disabled when `GATEWAY_SECRET` is empty | `server/src/gateway.ts:179` | `if (!GATEWAY_SECRET) return true` — risky if misconfigured |
| **MEDIUM** | CORS `*` hardcoded in LLM proxy and sandbox proxy | `gateway/src/llm-proxy.ts:94`, `gateway/src/proxy.ts` | Not controlled by `CORS_ORIGIN` env var |
| **MEDIUM** | Sandbox Dockerfile runs as root | `server/Dockerfile` | Agent has bash tools; gateway Dockerfile correctly uses `USER node` |
| **LOW** | Internal error messages leaked to clients | `gateway/src/auth.ts:55`, `llm-proxy.ts:98`, `proxy.ts:174` | Could expose internal hostnames on failure |
| **LOW** | `/health` endpoint unauthenticated | `server/src/gateway.ts:487-502` | Exposes model name, uptime, session count |

### iOS (xiaozhuo-meios-ios)

| Priority | Issue | Location | Notes |
|----------|-------|----------|-------|
| **LOW** | No certificate pinning | `MeiosAPI.swift:1` (TODO exists) | MITM with rogue CA could intercept |
| **LOW** | Debug `print()` in release builds | `AuthService.swift:75`, `CollectionsViewModel.swift:18,26,36`, `ChatViewModel.swift:226` | Use `os.Logger` or `#if DEBUG` |
| **LOW** | Force unwrap on server URL | `MeiosAPI.swift:366` (`ImageItem.resolvedURL`) | Could crash on malformed server response |

---

## Verified Secure

- **No secrets in source or git history** — all credentials via env vars / Keychain
- **Supabase `sb_publishable_` key** — confirmed public/client-safe (new 2025-06 format replacing `eyJ...` anon key)
- **SQL injection** — all queries use parameterized statements (`better-sqlite3` prepared statements)
- **Command injection** — no `exec`/`spawn` calls in server code
- **Path traversal** — `..` check + `startsWith(WORKSPACE)` validation on all file endpoints
- **Auth token storage** — iOS uses Keychain (`kSecClassGenericPassword`), not UserDefaults
- **Dependencies** — no known CVEs in current versions
