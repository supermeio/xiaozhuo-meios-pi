# Code Review Report — 2026-03-11

Self-review of all meios codebases. Findings sorted by severity.

---

## CRITICAL (fix before next deploy)

### 1. Supabase credentials hardcoded in iOS source
**iOS `AuthService.swift:16-18`**
- Project URL and publishable key in source code, committed to git
- Publishable key is designed to be public, but project ID leaks infrastructure
- **Fix**: Move to `Info.plist` or build config, consider rotating key

### 2. NSAllowsArbitraryLoads = true in production
**iOS `Info.plist:19-20`**
- Allows plain HTTP in all builds, enables MITM attacks
- Dev env uses `http://openclaw-011...` which needs it, but production doesn't
- **Fix**: Remove global allow, add `NSExceptionDomains` for dev host only

### 3. No request body size limit on LLM proxy
**Gateway `llm-proxy.ts:49`, Edge Function `index.ts:88`**
- Valid sandbox token holder can send arbitrarily large payloads → billing abuse
- **Fix**: Check `Content-Length` header, reject >100KB

### 4. Race condition in sandbox provisioning
**Gateway `proxy.ts:14-29`**
- Two simultaneous requests from same user → both see no sandbox → both provision
- Result: duplicate sandboxes, orphaned resources
- **Fix**: DB-level UPSERT lock on `user_id`, or use `SELECT ... FOR UPDATE`

---

## HIGH (fix soon)

### 5. Sandbox tokens: plaintext, no expiration, no rotation
**Gateway `db.ts:60-70`, `sandbox.ts:72`**
- Tokens stored as-is in DB, valid forever
- DB compromise = all sandbox tokens exposed = unlimited LLM access
- **Fix**: Hash tokens in DB (bcrypt/SHA-256), add expiry column, rotate on refresh

### 6. No rate limiting on LLM proxy
**Gateway `llm-proxy.ts`, Edge Function `llm-proxy/index.ts`**
- Sandbox with valid token can spam Anthropic API without throttle
- **Fix**: Per-sandbox rate limit (e.g., 100 req/min), counter in Supabase or in-memory

### 7. Race condition on concurrent chat sends (iOS)
**iOS `ChatViewModel.swift:71-107`**
- `isSending` guard check happens too late, button not properly disabled
- Rapid taps → duplicate messages
- **Fix**: `guard !isSending else { return }` at top of `sendCurrentDraft()`

### 8. No HTTP status code validation on GET requests (iOS)
**iOS `MeiosAPI.swift:30-35`**
- `chat()` checks status codes, but `get()` doesn't — 500 errors try to JSON decode
- **Fix**: Add `guard (200...299).contains(http.statusCode)` to `get()`

### 9. Session cache grows unbounded (server)
**Server `gateway.ts:190`**
- `sessionCache = new Map()` — no TTL, no size limit, no eviction
- Long-running gateway → memory leak
- **Fix**: LRU cache with max size (100) and TTL (24h)

### 10. Path traversal in session routes (server)
**Server `gateway.ts:330-363`**
- Session ID from URL not validated against format
- `resolve(SESSIONS_DIR, sessId)` with `..` could escape
- **Fix**: Validate pattern `/^s-\d+-[a-z0-9]+$/` before use

### 11. No token refresh / 401 handling (iOS)
**iOS `AuthService.swift:32-43`**
- Token expires mid-session → API calls fail → user confused
- No automatic refresh, no 401 intercept
- **Fix**: Retry on 401 with refreshed token, proactive refresh before expiry

---

## MEDIUM (schedule for next sprint)

### 12. CORS too permissive
**Gateway `index.ts:12-16`** — `origin: '*'` on all routes including LLM proxy

### 13. Hardcoded Supabase project URL in gateway config
**Gateway `config.ts:24`** — `exyqukzhnjhbypakhlsp.supabase.co` as default fallback

### 14. Cron task overlap (server)
**Server `cron.ts:76-79`** — `run()` not awaited, no concurrent-run guard

### 15. Silent error on session message load (iOS)
**iOS `ChatViewModel.swift:48-62`** — catch block empty, user sees blank conversation

### 16. Message IDs use Date.now() not UUID (iOS)
**iOS `Message.swift:21-28`, `ChatViewModel.swift:92`** — possible collisions

### 17. Stringly-typed `role` field (iOS)
**iOS `MeiosAPI.swift:111-113`** — `role: String` should be enum

### 18. Sign-out errors swallowed (iOS)
**iOS `AuthService.swift:69`** — `try? await auth.signOut()` fails silently

### 19. No structured logging (gateway + server)
All errors go to `console.error` with inconsistent format

### 20. Docker runs as root
**Gateway `Dockerfile`** — no `USER node` directive

---

## LOW (backlog / nice-to-have)

### 21. `(model as any).baseUrl` hack
**Server `gateway.ts:54`, `index.ts:64`** — pi-ai SDK hardcodes baseUrl, forced cast

### 22. 3-second arbitrary sleep for gateway startup
**Gateway `sandbox.ts:116`** — should poll health with backoff

### 23. Inline node.js health check script
**Gateway `sandbox.ts:119-121`** — fragile, hard to maintain

### 24. Multiple hardcoded values not configurable
- Signed URL TTL (24h), refresh buffer (1h)
- Sandbox resources (2 CPU, 2GB, 5GB)
- Model ID `claude-haiku-4-5`
- Cron intervals (4h, 24h)
- iOS request timeout (60s)

### 25. 15+ instances of `any` type in server code
**Server `gateway.ts`, `index.ts`** — defeats TypeScript type checking

### 26. No certificate pinning (iOS)
**iOS `MeiosAPI.swift:5`** — uses default URLSession

### 27. Placeholder attachment button enabled (iOS)
**iOS `ChatSheetView.swift:207-214`** — non-functional button visible to users

### 28. No haptic feedback distinction for success/failure (iOS)
**iOS `ChatSheetView.swift:267-275`** — haptic fires even on send failure

### 29. Wardrobe tool params not validated (server)
**Server `tools.ts:38-61`** — no length limits, no category enum validation

### 30. Heartbeat overwrites without merging (server)
**Server `heartbeat.ts:26-28`** — second run overwrites first suggestions

---

## Summary

| Severity | Count | Gateway | Server | iOS |
|----------|-------|---------|--------|-----|
| Critical | 4 | 2 | - | 2 |
| High | 7 | 3 | 2 | 3 |
| Medium | 9 | 3 | 1 | 5 |
| Low | 10 | 3 | 4 | 3 |
| **Total** | **30** | **11** | **7** | **13** |

Top priorities for next session:
1. iOS security hardening (#1, #2, #7, #8, #11)
2. LLM proxy protection (#3, #5, #6)
3. Sandbox provisioning race condition (#4)
