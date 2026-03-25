# Sandbox Startup Optimization

## Background

meios sandbox runs on Fly.io Machines with JuiceFS (networked filesystem).
The agent framework (`@mariozechner/pi-coding-agent`) is designed for local CLI usage
where disk I/O is fast. On JuiceFS, every `existsSync` / `readdirSync` is a remote call,
making the framework's startup path extremely slow.

## Diagnosis methodology

All findings below were obtained through:
- **Timing logs** in `gateway.ts` at key lifecycle points (`[chat]`, `[chatStream]` prefixed)
- **Automated curl tests** against the Fly.io sandbox endpoint, with `flyctl machines stop`
  to simulate cold starts
- **`flyctl logs`** analysis to correlate Firecracker, JuiceFS, and application-level events

## Problem 1: JuiceFS mount timeout causes restart loops

### Symptom

Cold starts intermittently took 2-4 minutes. Logs showed:
```
juicefs FATAL: the mount point is not ready in 10 seconds
Main child exited normally with code: 1
reboot: Restarting system
machine has reached its max restart count of 3
```

### Root cause

`jfsmount mount ... -d` (background mode) has a **hardcoded 10-second timeout** in the
JuiceFS Cloud binary. On Fly.io cold starts, GCS metadata fetch can take 10-20 seconds,
causing the mount to be declared failed even though it would have succeeded with more time.

Each FATAL triggers a process exit → machine restart → another mount attempt, creating
a restart loop that consumes 2-3 minutes before eventually succeeding.

Note: The open-source JuiceFS (>= v1.2.0) supports `JFS_MOUNT_TIMEOUT` env var, but the
Cloud binary (`jfsmount` from `s.juicefs.com/static/Linux/mount`) does not honor it.

### Fix

Added retry loop in `entrypoint.sh` (up to 5 attempts with 3s sleep between retries):
```bash
for attempt in $(seq 1 $MAX_RETRIES); do
  if $MOUNT_CMD 2>&1; then break; fi
  fusermount -u /persistent 2>/dev/null || true
  sleep 3
done
```

This keeps the mount attempts within a single machine lifecycle instead of triggering
full machine restarts.

### Result

| Scenario | Before | After |
|----------|--------|-------|
| JuiceFS mount succeeds on first try | 7s | 7s (same) |
| JuiceFS mount needs retry | **FATAL → restart loop (2-4min)** | **13s (retry within process)** |

## Problem 2: `resourceLoader.reload()` takes 64 seconds

### Symptom

`createAgentSession()` hung for 64+ seconds, or hung indefinitely.

### Root cause

`createAgentSession()` internally creates a `DefaultResourceLoader` and calls `reload()`,
which does heavy directory scanning:

```
reload()
├── packageManager.resolve()              ← scans npm packages, resolves deps
│   ├── getGlobalSettings()               ← reads ~/.pi/agent/settings.json
│   ├── getProjectSettings()              ← reads .agents/settings.json
│   ├── resolvePackageSources()           ← downloads/installs npm extensions
│   └── addAutoDiscoveredResources()      ← recursive directory scan
│       ├── cwd/.agents/extensions/
│       ├── cwd/.agents/skills/
│       ├── cwd/.agents/prompts/
│       ├── cwd/.agents/themes/
│       ├── ~/.pi/agent/extensions/
│       ├── ~/.pi/agent/skills/
│       └── walks from cwd up to / looking for .agents/skills/
├── loadExtensions()                      ← dynamically loads JS extensions
├── loadSkills()                          ← parses SKILL.md files
├── loadPromptTemplates()                 ← parses prompt templates
├── loadThemes()                          ← loads UI themes
└── loadProjectContextFiles()             ← finds CLAUDE.md / AGENTS.md
```

On local SSD (e.g., openclaw): completes in seconds.
On JuiceFS (meios sandbox): **64 seconds**.

### Fix: Skip `reload()` entirely

We don't use any of these features:
- No skills (yet — see "Future: Skills Support" below)
- No extensions
- No prompt templates
- No themes
- System prompt is loaded from SOUL.md + MEMORY.md via our own `loadSystemPrompt()`

What we do instead:

1. **Create a lightweight `DefaultResourceLoader`** with all discovery disabled:
   ```typescript
   const resourceLoader = new DefaultResourceLoader({
     cwd: AGENT_DIR,        // ephemeral disk, NOT /persistent (JuiceFS)
     agentDir: AGENT_DIR,
     settingsManager,
     noExtensions: true,
     noSkills: true,
     noPromptTemplates: true,
     noThemes: true,
   })
   // Do NOT call reload() — not needed
   ```

2. **Pass it to `createAgentSession()`** so the library skips its own creation + reload:
   ```typescript
   const { session } = await createAgentSession({
     cwd: AGENT_DIR,        // avoid JuiceFS scans
     agentDir: AGENT_DIR,
     resourceLoader,        // pre-created, no reload
     settingsManager,
     // ...
   })
   ```

3. **Set system prompt per request** via the correct API:
   ```typescript
   session.agent.setSystemPrompt(loadSystemPrompt())
   ```
   Note: `PromptOptions` does NOT support `systemPrompt` — passing it as an option
   is silently ignored. This was a bug that caused the agent to hang after `agent_start`.

## Problem 3: SSE connection drops on long requests

### Symptom

iOS app shows "connection lost" (NSURLErrorDomain Code=-1005) during image generation.

### Root cause

- Cloud Run default request timeout (240s) < iOS client timeout (300s)
- No SSE heartbeat — intermediate network layers drop idle connections
- `ensureUploaded()` (R2 image upload) could block the SSE stream indefinitely

### Fix

- Set Cloud Run `--timeout 300` to match iOS client
- Add 20s SSE heartbeat (`: keepalive\n\n`)
- Wrap `ensureUploaded()` with 30s timeout, fallback to `/files/` URL

## Problem 4: Node.js module loading takes 14 seconds

### Symptom

`node dist/gateway.mjs` → `server.listen()` takes 14 seconds on 1CPU/1GB Fly.io machine.

### Root cause

The esbuild config marked all heavy dependencies as `--external`:
```
--external:@mariozechner/pi-coding-agent --external:@aws-sdk/client-s3 ...
```

Result: bundled output was only 66KB, but Node.js still resolved and loaded 294 packages
from `node_modules/` at runtime — hundreds of file open/read/parse operations on cold disk.

### Fix: Aggressive bundling

Bundle everything except native addons (C++ `.node` files that can't be bundled):
```
--external:better-sqlite3    # native SQLite addon
--external:fsevents          # macOS-only, Linux uses inotify
--external:koffi             # Windows FFI, not used on Linux
--external:@silvia-odwyer/photon-node  # native image processing
--external:@mariozechner/clipboard-*   # native clipboard, CLI-only
```

| Metric | Before | After |
|--------|--------|-------|
| Bundle size | 66KB | 10.5MB |
| External packages at runtime | 294 | 1 (better-sqlite3) |
| Import time (local Mac) | 342ms | 207ms |
| Import time (Fly.io 1CPU, est.) | **14s** | **~1-2s** |

### Why this works

On a cold Firecracker VM with no filesystem cache:
- **Before**: Node.js opens ~294 `package.json` + `.js` files, each a separate `open()` + `read()` syscall
- **After**: Node.js reads 1 file (10.5MB), V8 parses it once

The Dockerfile was also updated: runtime stage installs only `better-sqlite3` instead of
all 294 packages, reducing image build time and size.

## Problem 5: `initSync().reconcile()` runs on startup

### Symptom

Although `initSync()` is fire-and-forget (no `await`), `reconcile()` runs immediately on
startup, scanning JuiceFS directories and uploading to R2. This competes with the first
`/chat` request for CPU and I/O.

### Fix: Defer reconcile by 15 seconds

Start the chokidar file watcher immediately (lightweight), but delay `reconcile()` by 15s.
Any new file changes during the delay are captured by the watcher. The reconcile catches
pre-existing files that were missed during sandbox sleep.

```typescript
// Start watcher immediately (lightweight)
const watcher = startWatcher(config)

// Defer reconcile to avoid competing with first request
setTimeout(async () => {
  const { uploaded, deleted } = await reconcile(config)
}, 15_000)
```

## Problem 6: SQLite on JuiceFS takes 24 seconds to open

### Symptom

`setWorkspaceRoot()` takes 24 seconds during deferred init. The SQLite DB (`collections.db`)
lives on JuiceFS at `/persistent/.meios/collections.db`. Opening and initializing it involves
many small file I/O operations (open, read, fstat, WAL creation, schema execution), each
going through FUSE → PG metadata query (~600ms).

### Fix: Local ephemeral disk + async backup

1. SQLite DB runs on local disk (`/tmp/meios/<hash>/collections.db`) — instant I/O
2. On cold start: `copyFileSync()` from JuiceFS → local (single file read, ~1s)
3. After writes: debounced `db.backup()` to JuiceFS (async, 5s debounce)

```typescript
// Restore from JuiceFS if local doesn't exist (cold start)
if (!existsSync(localDbPath) && existsSync(persistentDbPath)) {
  copyFileSync(persistentDbPath, localDbPath)
}
_db = new Database(localDbPath)  // local disk, instant

// After any write:
function scheduleBackup() {
  if (backupTimer) clearTimeout(backupTimer)
  backupTimer = setTimeout(() => {
    _db.backup(persistentDbPath)  // async, non-blocking
  }, 5_000)
}
```

### Result

| Metric | Before | After |
|--------|--------|-------|
| `setWorkspaceRoot()` | **24s** | **1.5s** |
| Total deferred init | **25s** | **3s** |
| Chat ready (from machine start) | **40s** | **18s** |

## Combined results

Cold start (from stopped machine to first token):

| Stage | Original | After optimization |
|-------|----------|-------------------|
| Firecracker boot | 2s | 2s |
| JuiceFS mount | 7s or **FATAL loop (2-4min)** | **7s (retry ensures success)** |
| Node.js → HTTP ready | 14s | **6s (aggressive bundling)** |
| `resourceLoader.reload()` | **64s** | **0s (skipped)** |
| `getOrCreateSession()` | **hang (5min+)** | **233ms** |
| `loadSystemPrompt()` | N/A | 21ms |
| `session.prompt()` → first token | N/A | 59ms |
| Deferred workspace init | N/A (was inline) | **3s (SQLite on local disk)** |
| `initSync()` reconcile | blocks first request | **deferred 15s (non-blocking)** |
| **Total (health check)** | **2-5min or hang** | **~15s** |
| **Total (chat ready)** | | **~18s** |

With `autostop=suspend` (resume from memory snapshot, **now enabled**):

| Stage | Time |
|-------|------|
| Firecracker resume | 500ms–3.3s |
| `getOrCreateSession()` | 45-151ms |
| `loadSystemPrompt()` | 12ms (cached) – 6.5s (stale FUSE) |
| `session.prompt()` → first token | 29-59ms |
| **Total** | **1.5–4.5s** |

## Decision: `autostop=suspend` over `autostop=stop`

**Enabled on 2026-03-25.** This is the primary operating mode for all meios sandboxes.

### What suspend does

Firecracker saves the entire VM state to a snapshot: CPU registers, memory contents,
open file handles, FUSE mounts, Node.js heap — everything. Resume restores from this
snapshot instead of cold booting. No JuiceFS mount, no Node.js startup, no workspace
init needed.

### Suspend vs stop

| | `autostop=stop` | `autostop=suspend` |
|---|---|---|
| Resume time | Cold start (~18s) | Memory snapshot (~1.5-4.5s) |
| CPU/RAM billing when idle | $0 | $0 |
| Storage billing when idle | rootfs $0.15/GB/mo | **Same** — rootfs $0.15/GB/mo |
| How it works | Full shutdown → cold boot | Snapshot save → snapshot restore |

**Billing is identical.** There is no cost penalty for using suspend over stop.

### Requirements and limitations

Suspend requires ([docs](https://fly.io/docs/reference/suspend-resume/)):

- **Memory ≤ 2GB** — snapshot write/restore time grows with memory size.
  Our machines are 1GB, well within the limit.
- **No swap, no GPU, no schedule** — none of which we use.

Known caveats:
- **Some logs may be lost** after resume (minor, non-blocking).
- **TCP connections are broken** on resume — clients must reconnect.
  Our iOS app already handles this (SSE reconnects on NSURLError).
- **JuiceFS stale sessions** — FUSE process resumes with old session state.
  JuiceFS auto-cleans stale sessions on next metadata operation (confirmed in logs:
  `clean up stale session 13 ... : <nil>`). No manual intervention needed.
- **Large memory → slow suspend** — >2GB machines may take seconds to write the
  snapshot, reducing the benefit. Not an issue at 1GB.

### Why not everyone uses suspend

1. **Memory limit** — many production apps need >2GB, making suspend unavailable.
2. **Stale state** — some apps need clean restarts to refresh DB connections, config,
   or cached data. Suspend restores the exact pre-suspend state, including stale caches.
3. **Network connections break** — apps relying on long-lived TCP/WebSocket connections
   need reconnection logic. Not all frameworks handle this gracefully.
4. **Relatively new feature** — suspend was preview until mid-2025. Some teams haven't
   evaluated it yet.

For meios, none of these are blockers:
- 1GB memory (within limit)
- JuiceFS FUSE handles stale sessions automatically
- iOS app already has SSE reconnection logic
- No long-lived external TCP connections from the sandbox

### Configuration

```bash
flyctl machines update <MACHINE_ID> --app meios-sandbox-test \
  --autostop=suspend \
  --autostart \
  --yes
```

- `autostop=suspend`: Fly proxy suspends machine after idle period (no traffic)
- `autostart=true`: Fly proxy auto-resumes on incoming HTTP request
- `min_machines_running=0`: allow all machines to suspend when idle

### When cold start still happens

Suspend only helps for **the same machine resuming**. A full cold start (18s) still
occurs when:
- Machine is destroyed and re-provisioned (new user, or manual destroy)
- Machine image is updated (`flyctl machines update --image ...`)
- Machine hits max restart count after a crash
- Fly.io migrates the machine to a different host (rare, but happens)

## Why openclaw doesn't have this problem

openclaw runs pi-coding-agent on persistent VMs with local SSD:
- Process stays running (systemd), no cold start per request
- `reload()` scans local disk: seconds, not minutes
- No Firecracker, no JuiceFS mount

## Future: Skills Support

When we need skills in sandbox, do NOT re-enable `reload()`. Instead:

**Recommended: On-demand from JuiceFS (Option B)**

Read SKILL.md from `/persistent/skills/` when user enables a skill.
Cache in memory. Inject into system prompt:
```typescript
const skills = readFileSync('/persistent/skills/weather/SKILL.md', 'utf-8')
session.agent.setSystemPrompt(systemPrompt + '\n\n' + skills)
```

**Alternative: Build-time (Docker image)**
```typescript
const resourceLoader = new DefaultResourceLoader({
  additionalSkillPaths: ['/app/skills'],  // local disk, instant
  noSkills: true,  // disable auto-discovery, only use additionalSkillPaths
})
```

Core principle: **know where your files are and read them directly.
Never let the framework "discover" them via recursive directory scanning on networked storage.**

## Problem 4: JuiceFS Cloud mount timeout (juicefs.com in China)

### Symptom

Cold starts intermittently took 2-4 minutes. `jfsmount mount -d` fails with:
```
juicefs FATAL: the mount point is not ready in 10 seconds
```

Even with foreground mount (`-f &`) and 60s timeout, mount still fails intermittently.

### Root cause

`jfsmount` (JuiceFS Cloud binary) authenticates with `https://juicefs.com` on every mount.
**juicefs.com is hosted on Alibaba Cloud Beijing (IP: 47.93.5.40).**

From Fly.io `iad` (US East) to Alibaba Cloud Beijing:
- Crosses the Pacific Ocean + Great Firewall
- Base latency 200-400ms with significant jitter
- Intermittent packet loss causes `context deadline exceeded`

Verbose logs confirmed:
```
auth with https://juicefs.com/volume/meios-persistent/mount
WARNING: get config: POST https://juicefs.com/volume/meios-persistent/mount:
  context deadline exceeded (Client.Timeout exceeded while awaiting headers)
```

When juicefs.com is reachable: mount completes in 4-10s.
When juicefs.com times out: mount fails even with 60s timeout.

### Interim fixes applied

1. **Foreground mount with shell-controlled timeout** (`-f &` + `mountpoint -q` polling, 60s)
   - Bypasses jfsmount's hardcoded 10s timeout for `-d` mode
   - Still fails when juicefs.com is unreachable

2. **`--no-update` flag** (if cached config exists)
   - Skips the POST to juicefs.com, uses locally cached config
   - Only works after first successful mount (config cached at `~/.juicefs/volume.conf`)
   - Cache is lost on every deploy (new Docker image)

3. **Credential cleanup in entrypoint.sh**
   - After mount: `unset JUICEFS_TOKEN JUICEFS_GCS_KEY_B64`, delete GCS key file
   - Prevents agent bash tool from reading shared credentials
   - Note: this is a defense-in-depth measure, not a complete solution (see Security below)

### These fixes are NOT sufficient for production

The fundamental problem remains: JuiceFS Cloud depends on a server in China,
and China-US network is inherently unreliable. No amount of retrying or caching
fully solves this.

## CRITICAL: JuiceFS shared credential security issue

### Problem

All sandbox machines share the same credentials:
- `JUICEFS_TOKEN`: can mount the **entire** JuiceFS volume (all users' data)
- `JUICEFS_GCS_KEY_B64`: GCS service account private key (can access all GCS data)

The pi-coding-agent has a `bash` tool. If a user triggers `printenv` or reads
`/proc/self/environ`, they get these shared secrets → can access all users' files.

**This is a catastrophic security risk at scale.** With 100K users sharing one token,
a single leak exposes everyone.

### Why entrypoint cleanup is not enough

Clearing env vars after mount (`unset`) blocks the most obvious attack vector,
but is NOT acceptable as the sole defense:
- Advanced attacks (memory dumps, /proc inspection of jfsmount process) may still leak
- Defense-in-depth requires the credentials to never enter the sandbox environment at all

### Solution: Migrate to self-hosted JuiceFS (open source) + AWS S3

Replace JuiceFS Cloud with self-hosted JuiceFS. This eliminates both problems:
1. No dependency on juicefs.com (China) → stable mount
2. Per-user volumes with per-user credentials → zero shared secrets

#### Architecture decision: Object storage selection

Evaluated 2026-03-24. Requirements: per-user credential isolation, full JuiceFS
compatibility (including `gc`, `fsck`), low latency from Fly.io `iad`.

| Storage | Per-prefix credentials | JuiceFS full compat | Latency from iad | Notes |
|---------|----------------------|--------------------|--------------------|-------|
| **AWS S3** | **IAM Policy per prefix** | **All commands work** | **~1ms (same region)** | **Selected** |
| Cloudflare R2 | API Token per prefix | gc/fsck/sync/destroy broken (v1.3.1) | Low | R2 ListObjects unsorted |
| GCS | Downscoped Token (1h expiry) | All commands work | ~10ms | Needs token refresh mechanism |
| Backblaze B2 | Application Key per prefix | All commands work | Medium | Cheap but less mature IAM |

**Decision: AWS S3 (`us-east-1`)**

Reasons:
- **Per-user IAM**: Create an IAM policy per user scoped to `s3:*` on `arn:aws:s3:::bucket/user-{id}/*`.
  Permanent credentials (no refresh needed). Leak only affects that user.
- **Full JuiceFS compatibility**: Native S3 — `gc`, `fsck`, `sync`, `destroy` all work.
  No workarounds needed (unlike R2's `--backup-meta 0`).
- **Co-located with Fly.io**: S3 `us-east-1` and Fly.io `iad` are both in Virginia.
  Sub-millisecond latency for data operations.

**R2 detailed evaluation (2026-03-24):**

R2 的 `ListObjects` API 不保证返回排序结果，这是 Cloudflare 的架构选择（非 bug），
违反了 AWS S3 规范中的字典序保证。
([JuiceFS docs](https://juicefs.com/docs/community/reference/how_to_set_up_object_storage/#r2),
[GitHub #2155](https://github.com/juicedata/juicefs/issues/2155))

这是 **Cloudflare 的问题，不是 JuiceFS 的问题**。JuiceFS 合理地依赖了 S3 规范保证。

JuiceFS 正在适配：PR #6389（2025-09-26 合并到 main）让 gc/fsck/destroy 传 `sort=false`，
不再要求排序。但截至 v1.3.1（2025-12-02，最新正式版）该修复未发布。`sync` 命令仍依赖排序。

| JuiceFS 命令 | 需要排序？ | R2 可用？(v1.3.1) | R2 可用？(main) |
|-------------|-----------|------------------|----------------|
| `mount` | 否 | 可以（加 `--backup-meta 0`） | 可以 |
| `gc` | 是 → 否(main) | **不行** | 可以 |
| `fsck` | 是 → 否(main) | **不行** | 可以 |
| `sync` | 是 | **不行** | **不行** |
| `destroy` | 是 → 否(main) | **不行** | 可以 |

结论：即使自编译 main 分支，`sync` 仍不可用，且依赖未发布代码不适合生产环境。
S3 完全兼容，无需任何适配。

**GCS was rejected**: Per-user isolation requires Downscoped Tokens which expire after
1 hour max. JuiceFS FUSE needs persistent credentials, so a token refresh mechanism
would be required — adding complexity with no benefit over S3.

**Note: 图片存储不受影响。** 图片走的是独立的 Cloudflare R2（通过 presigned URL 上传，
CDN 直接读取），与 JuiceFS 无关。R2 做简单的对象读写完全没问题，ListObjects 排序问题
只影响 JuiceFS 的 gc/fsck 等管理命令。迁移 JuiceFS 到 S3 只影响 `/persistent/` 下的
用户工作空间文件（agent workspace、记忆、配置）。

#### Target architecture

```
juicefs (open source) = metadata engine + object storage

Metadata: PostgreSQL (Supabase — already have)
Data:     AWS S3 us-east-1 (new bucket)
Auth:     no external service needed (no juicefs.com)
```

Per-user isolation:
```bash
# During user provisioning (gateway side, not in sandbox):
# 1. Create PG schema for user's metadata
# 2. Create S3 IAM user with policy scoped to user's prefix
# 3. Format JuiceFS volume
juicefs format \
  "postgres://supabase-url?search_path=juicefs_${USER_ID}" \
  "user-${USER_ID}" \
  --storage s3 \
  --bucket https://meios-juicefs.s3.us-east-1.amazonaws.com

# In sandbox (only this user's metadata + S3 credentials):
juicefs mount \
  "postgres://supabase-url?search_path=juicefs_${USER_ID}" \
  /persistent
```

Each user gets:
- Own PostgreSQL schema (isolated metadata namespace)
- Own S3 IAM credentials (can only access `user-{id}/*` prefix)
- Leak of one user's credentials cannot access any other user's data

| Aspect | JuiceFS Cloud (current) | JuiceFS self-hosted + S3 |
|--------|------------------------|--------------------------|
| Auth server | juicefs.com (Beijing) | Not needed |
| Cold start mount | Unreliable (China-US) | Stable (Supabase + S3 in US) |
| User isolation | Shared token (all users) | Per-user volume + per-user S3 IAM |
| Data credentials | Shared GCS service account | Per-user S3 access key |
| JuiceFS compat | Full (Cloud managed) | Full (native S3) |
| Ops complexity | Low | Medium (manage metadata + IAM) |
| Cost | JuiceFS Cloud subscription | S3 storage (~$0.023/GB/mo) |
