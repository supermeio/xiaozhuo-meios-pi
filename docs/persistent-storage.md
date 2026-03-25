# Persistent Storage

> Design doc — 2026-03-15, updated 2026-03-25

## Motivation

meios gives each vertical agent (meio, etc.) a Fly.io sandbox with full filesystem access.
Sandbox filesystems are ephemeral — if a sandbox is destroyed or rebuilt, all data is lost.
We need a persistent filesystem that survives sandbox lifecycle events with near-zero cold start cost.

## Decision: Self-hosted JuiceFS + AWS S3

### What is JuiceFS

[JuiceFS](https://github.com/juicedata/juicefs) (13k+ stars, Go, Apache-2.0) is an open-source
POSIX-compatible filesystem that separates metadata and data storage:

```
Application code (fs.readFileSync, fs.writeFileSync)
  ↓ POSIX system calls
JuiceFS FUSE process (adapter + storage engine)
  ↓ splits into two paths
  ├→ metadata ops (ls, stat, mkdir) → PostgreSQL
  └→ data read/write (read, write) → S3 HTTP API
```

FUSE (Filesystem in Userspace) is a Linux kernel mechanism that allows a userspace program
to "pretend" to be a filesystem. JuiceFS translates POSIX file operations into PG queries + S3 requests.

Beyond simple translation, JuiceFS provides storage engine capabilities:
- **Chunking**: large files split into 4MB chunks on S3, enabling random read/write (S3 natively only supports whole-object operations)
- **Metadata caching**: `ls`, `stat` results cached in local memory, avoiding PG round-trips
- **Data caching**: hot data cached on local disk, reads don't hit S3
- **Consistency**: multiple clients mounting the same volume get consistent metadata via PG transactions

This is why JuiceFS was chosen over simpler alternatives like s3fs-fuse (no chunking, no caching, poor performance).

### Why JuiceFS

We evaluated three approaches:

| Route | Approach | Cold Start | Infra Cost | Agent Transparency |
|-------|----------|-----------|------------|-------------------|
| **A** | Daytona Volumes | <1s | None | Full |
| **B** | R2 API + lazy restore | <1s (db) + on-demand images | None | Partial (needs tool awareness) |
| **C** | JuiceFS + object storage | <1s (FUSE mount) + on-demand | Metadata engine | Full |

Route C was chosen because:
- **Agent transparency**: the agent sees a normal POSIX filesystem. No special tools needed for persistence — files written to the mount are automatically durable.
- **iCloud-like UX**: mount is instant, file content loads on first access, local cache makes repeated access fast.
- **Platform value**: this is infrastructure meios provides to all vertical agents, not a per-app hack.

Route A was rejected because Daytona Volumes can't run SQLite (no block storage semantics).
Route B works but requires every agent to understand lazy-loading — we'd rather make persistence invisible.

### Object Storage: AWS S3

**History**: Initially used JuiceFS Cloud Service with GCS backend (2026-03-15).
Migrated to self-hosted JuiceFS + AWS S3 on 2026-03-24 to eliminate:
1. Dependency on juicefs.com (hosted in China, unreliable from US)
2. Shared credential security risk (single token = access to all users' data)

See [juicefs-s3-migration-plan.md](juicefs-s3-migration-plan.md) for the full decision record
including R2/GCS/S3 comparison.

**Current architecture (2026-03-25):**
- **Metadata**: Supabase PostgreSQL (per-user schema isolation via PG roles)
- **Data**: AWS S3 `us-east-1` bucket `meios-juicefs` (per-user IAM isolation)
- **No central service**: open-source JuiceFS binary in each sandbox connects directly to PG + S3

### Image Delivery to iOS App

```
Agent writes → JuiceFS (/persistent/images/) → R2 sync → iOS app reads
                                                  ↑
                                        images.meios.ai (Cloudflare CDN)
```

- **Persistent storage**: JuiceFS (S3 backend) — agent workspace, collections DB
- **Image delivery**: Cloudflare R2 via presigned URL upload — images synced from workspace to R2 CDN
- JuiceFS and R2 are independent systems serving different purposes

### Why Fly.io over Daytona

We initially built on Daytona but discovered a blocking limitation:
- Daytona Tier 1-2 sandboxes have **restricted outbound network** (whitelist only)
- JuiceFS needs to reach its metadata engine and object storage
- Tier 3 requires **$500 prepaid spend** to unlock

We chose **Fly.io Machines**:
- **JuiceFS verified working** — FUSE mounts work out of the box (`/dev/fuse` available)
- **No network restrictions** on any plan
- **~300ms cold start** (Firecracker microVMs)
- **Cheapest option** — pay-per-second, stopped machines cost almost nothing
- **REST API** for programmatic machine create/start/stop/destroy

## Architecture

```
┌──────────────────────────────────────────────────┐
│      Fly.io Machine (per-user)                    │
│                                                   │
│  /app/              (ephemeral)                   │ ← agent code (Docker image)
│  /persistent/       (JuiceFS)                     │ ← user data
│    ├── .meios/collections.db                      │
│    ├── images/                                    │
│    └── ...                                        │
│                                                   │
│  juicefs mount $PG_DSN /persistent                │
│    (open-source binary, per-user PG role)         │
└──────────┬────────────────────┬───────────────────┘
           │                    │
     metadata ops          data read/write
           ↓                    ↓
   Supabase PostgreSQL     AWS S3 us-east-1
   (per-user schema)       (per-user IAM)
```

## Per-user Security Isolation

Each user gets completely isolated credentials:

| Layer | Isolation | Blast radius if leaked |
|-------|-----------|----------------------|
| PG metadata | Per-user role + schema, `REVOKE ALL ON public` | Only that user's file metadata |
| S3 data | Per-user IAM, policy scoped to `user-{uuid}/*` | Only that user's file data |
| Sandbox env | Credentials `unset` after mount, per-user PG DSN (no master password) | N/A |

Gateway (Cloud Run) holds admin credentials for provisioning; sandbox never sees them.

## Cold Start Performance (2026-03-25)

```
1. Firecracker start                (~1s)
2. JuiceFS format + mount           (~8s, PG latency ~600ms from iad → us-west-2)
3. Node.js → HTTP ready             (~6s, single 10.5MB esbuild bundle)
4. First LLM token                  (~5s, Kimi K2.5 with thinking enabled)
--- (background, non-blocking) ---
5. Workspace init                    (~3s, SQLite on local disk, restored from JuiceFS)
6. File sync reconcile              (~7s, deferred 15s after workspace ready)
```

Total cold start to health check: **~15s**.
Total cold start to first chat: **~18s** (workspace init ~3s in background).

### Optimization summary

Four optimizations reduced cold start from 50s+ to 18s (and 1.5-4.5s with suspend):

1. **Aggressive esbuild bundling**: All JS deps bundled into single 10.5MB file.
   Only `better-sqlite3` (native addon) remains external. Eliminates 294 separate
   module loads from disk. (14s → 6s)

2. **Deferred workspace init**: `setWorkspaceRoot()`, `initCron()`, `initHeartbeat()`
   all access JuiceFS (600ms+ per file op). Moved to `setImmediate()` after `server.listen()`.
   HTTP server starts accepting requests immediately. (35s → 6s for HTTP ready)

3. **Local SQLite**: `collections.db` moved from JuiceFS to `/tmp/meios/` (local ephemeral
   disk). On cold start: `copyFileSync` from JuiceFS (1.5s vs 24s). After writes: async
   `db.backup()` to JuiceFS with 5s debounce.

4. **Deferred sync reconcile**: `initSync().reconcile()` scans JuiceFS + uploads to R2.
   Deferred 15s after workspace ready. Watcher starts immediately. (non-blocking)

5. **`autostop=suspend`**: Firecracker memory snapshot — resume skips all startup steps.
   See decision rationale below.

### Decision: `autostop=suspend` (2026-03-25)

Sandbox machines use `autostop=suspend` instead of `autostop=stop`.

```
Resume from suspended state:  ~0.5-3.3s (machine start)
                            + ~10ms (reachable)
Total:                        ~1.5-4.5s (user-perceived, vs 18s cold start)
```

**How it works**: Firecracker saves the entire VM state (CPU registers, memory, file handles,
JuiceFS FUSE, Node.js heap) to a snapshot. Resume restores from snapshot — no boot, no mount,
no Node.js startup needed.

**Why suspend over stop**:
- **Same cost** — billing is identical ($0 for CPU/RAM, rootfs $0.15/GB/mo for both)
- **10x faster resume** — 1.5-4.5s vs 18s cold start
- **No compatibility issues** — JuiceFS auto-cleans stale sessions on resume,
  iOS app already handles SSE reconnection

**Requirements** (all met by our 1GB machines):
- Memory ≤ 2GB (suspend snapshot grows with memory)
- No swap, GPU, or schedule configured

**When cold start still happens** (suspend doesn't help):
- Machine destroyed and re-provisioned (new user)
- Machine image updated (`flyctl machines update --image`)
- Fly.io host migration (rare)

See [sandbox-startup-optimization.md](sandbox-startup-optimization.md) for full technical details.

## Configuration

- **Fly.io App**: `meios-sandbox-test`, region `iad`
- **S3 Bucket**: `meios-juicefs`, region `us-east-1`
- **Supabase PG**: per-user schema `juicefs_{userId}`, per-user role `juicefs_user_{userId}`
- **Provisioning**: automatic on first user request (gateway creates PG role + IAM user + Fly machine)

## References

- [JuiceFS open source](https://github.com/juicedata/juicefs) — 13k+ stars, Go, Apache-2.0
- [JuiceFS docs](https://juicefs.com/docs/community/)
- [JuiceFS S3 migration plan](juicefs-s3-migration-plan.md) — full decision record for S3 over R2/GCS
- [Sandbox startup optimization](sandbox-startup-optimization.md) — cold start diagnosis and fixes
- [Fly.io Machines API](https://fly.io/docs/machines/overview/)
