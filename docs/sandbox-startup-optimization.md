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

## Combined results

Cold start (from stopped machine to first token):

| Stage | Original | After optimization |
|-------|----------|-------------------|
| Firecracker boot | 2s | 2s |
| JuiceFS mount | 7s or **FATAL loop (2-4min)** | **7s (retry ensures success)** |
| Node.js → gateway ready | 14s | 14s |
| `resourceLoader.reload()` | **64s** | **0s (skipped)** |
| `getOrCreateSession()` | **hang (5min+)** | **233ms** |
| `loadSystemPrompt()` | N/A | 21ms |
| `session.prompt()` → first token | N/A | 59ms |
| **Total** | **2-5min or hang** | **~24-40s** |

With `autostop=suspend` (resume from memory snapshot):

| Stage | Time |
|-------|------|
| Firecracker resume | 336ms–467ms |
| `getOrCreateSession()` | 45-151ms |
| `loadSystemPrompt()` | 12ms (cached) – 6.5s (stale FUSE) |
| `session.prompt()` → first token | 29-59ms |
| **Total** | **~1s – 7s** |

## Why openclaw doesn't have this problem

openclaw runs pi-coding-agent on persistent VMs with local SSD:
- Process stays running (systemd), no cold start per request
- `reload()` scans local disk: seconds, not minutes
- No Firecracker, no JuiceFS mount

## Fly.io machine configuration

- `autostop=suspend`: Firecracker memory snapshot, resume in sub-second, $0 while suspended
- `autostart=true`: Fly proxy auto-starts machine on incoming request
- `min_machines_running=0`: free tier; set to 1 for always-on (Pro feature, ~$5.70/mo)

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

### Solution: Migrate to self-hosted JuiceFS (open source)

Replace JuiceFS Cloud with self-hosted JuiceFS. This eliminates both problems:
1. No dependency on juicefs.com (China) → stable mount
2. Per-user volumes → no shared credentials

Architecture:
```
juicefs (open source) = metadata engine + object storage

Metadata: PostgreSQL (Supabase — already have)
Data:     GCS (already have) or R2 (already have)
Auth:     no external service needed
```

Per-user isolation:
```bash
# During user provisioning (gateway side, not in sandbox):
juicefs format \
  "postgres://supabase-url?prefix=user-${USER_ID}" \
  "gcs://meios-juicefs/user-${USER_ID}"

# In sandbox (only this user's metadata + data):
juicefs mount \
  "postgres://supabase-url?prefix=user-${USER_ID}" \
  /persistent
```

Each user gets:
- Own metadata prefix in PostgreSQL (isolated namespace)
- Own GCS path prefix (isolated data)
- Credentials scoped to their volume only

| Aspect | JuiceFS Cloud (current) | JuiceFS self-hosted |
|--------|------------------------|-------------------|
| Auth server | juicefs.com (Beijing) | Not needed |
| Cold start mount | Unreliable (China-US network) | Stable (Supabase in US) |
| User isolation | Shared token (all users) | Per-user volume |
| GCS credentials | Shared service account | Per-user scoped |
| Ops complexity | Low | Medium (manage metadata) |
| Cost | JuiceFS Cloud subscription | Free (open source) |
