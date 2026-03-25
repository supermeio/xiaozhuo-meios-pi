# Persistent Storage & Image Collections

> Design doc — 2026-03-15, updated 2026-03-25

## Motivation

meios gives each vertical agent (meio, etc.) a Fly.io sandbox with full filesystem access. The agent can create, read, update, and delete images freely. But two gaps remain:

1. **Persistence**: Sandbox filesystems are ephemeral. If a sandbox is destroyed or rebuilt, generated images are lost. The current R2 sync provides a backup, but there's no built-in "persistent filesystem" that survives sandbox lifecycle events with near-zero cold start cost.

2. **Collections**: Images are organized physically (directories), but vertical apps need logical grouping. A wardrobe agent needs "Spring Outfits" and "Work Looks" collections where the same image can appear in multiple places. File folders can't do this.

Both are platform-level capabilities that benefit any vertical agent, not just meio.

## Decision: JuiceFS (self-hosted) + AWS S3 + SQLite Collections

### What is JuiceFS

JuiceFS is an open-source POSIX-compatible filesystem that separates metadata and data storage:

```
Application code (fs.readFileSync, fs.writeFileSync)
  ↓ POSIX system calls
JuiceFS FUSE process (adapter + storage engine)
  ↓ splits into two paths
  ├→ metadata ops (ls, stat, mkdir) → PostgreSQL
  └→ data read/write (read, write) → S3 HTTP API
```

FUSE (Filesystem in Userspace) is a Linux kernel mechanism that allows a userspace program to "pretend" to be a filesystem. JuiceFS translates POSIX file operations into PG queries + S3 requests.

Beyond simple translation, JuiceFS provides storage engine capabilities:
- **Chunking**: large files split into 4MB chunks on S3, enabling random read/write (S3 natively only supports whole-object operations)
- **Metadata caching**: `ls`, `stat` results cached in local memory, avoiding PG round-trips
- **Data caching**: hot data cached on local disk, reads don't hit S3
- **Consistency**: multiple clients mounting the same volume get consistent metadata via PG transactions

This is why JuiceFS was chosen over simpler alternatives like s3fs-fuse (no chunking, no caching, poor performance).

### Why JuiceFS (Route C)

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

Route A was rejected because Daytona Volumes can't run SQLite (no block storage semantics). Route B works but requires every agent to understand lazy-loading — we'd rather make persistence invisible.

### Object storage: AWS S3 (migrated from GCS)

**History**: Initially used JuiceFS Cloud Service with GCS backend (2026-03-15). Migrated to self-hosted JuiceFS + AWS S3 on 2026-03-24 to eliminate:
1. Dependency on juicefs.com (hosted in China, unreliable from US)
2. Shared credential security risk (single token = access to all users' data)

See [juicefs-s3-migration-plan.md](juicefs-s3-migration-plan.md) for the full decision record including R2/GCS/S3 comparison.

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

- **Persistent storage**: JuiceFS (S3 backend) — agent workspace, closet data, collections DB
- **Image delivery**: Cloudflare R2 via presigned URL upload — images synced from workspace to R2 CDN
- JuiceFS and R2 are independent systems serving different purposes

### Why Fly.io over Daytona

We initially built on Daytona but discovered a blocking limitation during JuiceFS integration:
- Daytona Tier 1-2 sandboxes have **restricted outbound network** (whitelist only)
- JuiceFS needs to reach its metadata engine and object storage
- Tier 3 requires **$500 prepaid spend** to unlock

We chose **Fly.io Machines**:
- **JuiceFS verified working** — FUSE mounts work out of the box (`/dev/fuse` available)
- **No network restrictions** on any plan
- **~300ms cold start** (Firecracker microVMs)
- **Cheapest option** — pay-per-second, stopped machines cost almost nothing
- **REST API** for programmatic machine create/start/stop/destroy

### Architecture

```
┌──────────────────────────────────────────────────┐
│      Fly.io Machine (per-user)                    │
│                                                   │
│  /app/              (ephemeral)                   │ ← agent code (Docker image)
│  /persistent/       (JuiceFS)                     │ ← images, collections.db
│    ├── .meios/collections.db                      │
│    ├── images/                                    │
│    ├── closet/                                    │
│    └── looks/                                     │
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

### Per-user Security Isolation

Each user gets completely isolated credentials:

| Layer | Isolation | Blast radius if leaked |
|-------|-----------|----------------------|
| PG metadata | Per-user role + schema, `REVOKE ALL ON public` | Only that user's file metadata |
| S3 data | Per-user IAM, policy scoped to `user-{uuid}/*` | Only that user's file data |
| Sandbox env | Credentials `unset` after mount, per-user PG DSN (no master password) | N/A |

Gateway (Cloud Run) holds admin credentials for provisioning; sandbox never sees them.

### Cold Start Performance (2026-03-25)

```
1. Firecracker start                (~1s)
2. JuiceFS format (first time only) (~2s, skipped if already formatted)
3. JuiceFS mount                    (~7s, PG latency from iad → us-west-2)
4. Node.js gateway startup          (~36s, known optimization pending)
5. First LLM token                  (~5s, Kimi K2.5 with thinking enabled)
```

Total cold start: **~50s** (dominated by Node.js startup, not JuiceFS).

### Configuration

- **Fly.io App**: `meios-sandbox-test`, region `iad`
- **S3 Bucket**: `meios-juicefs`, region `us-east-1`
- **Supabase PG**: per-user schema `juicefs_{userId}`, per-user role `juicefs_user_{userId}`
- **Provisioning**: automatic on first user request (gateway creates PG role + IAM user + Fly machine)

## Collections Data Model

### Storage

SQLite database at `/persistent/.meios/collections.db`. Runs on JuiceFS mount — write amplification is negligible for our low-frequency collection operations.

### Schema

```sql
CREATE TABLE images (
    id TEXT PRIMARY KEY,                -- content hash (SHA-256)
    path TEXT NOT NULL,                  -- relative path from /persistent/
    filename TEXT NOT NULL,
    mime_type TEXT DEFAULT 'image/webp',
    width INTEGER,
    height INTEGER,
    size_bytes INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    metadata JSON                        -- prompt, model, generation params, etc.
);

CREATE TABLE collections (
    id TEXT PRIMARY KEY,                 -- UUID
    name TEXT NOT NULL,
    description TEXT,
    cover_image_id TEXT REFERENCES images(id),
    collection_type TEXT DEFAULT 'manual', -- 'manual' | 'smart'
    smart_query JSON,                     -- filter definition for smart collections
    sort_order TEXT DEFAULT 'added_at_desc',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE collection_images (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,
    added_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (collection_id, image_id)
);

CREATE INDEX idx_images_path ON images(path);
CREATE INDEX idx_images_hash ON images(id);
CREATE INDEX idx_ci_image ON collection_images(image_id);
CREATE INDEX idx_ci_collection ON collection_images(collection_id);
```

### Key Design Choices

**Content-hash identity**: `images.id` = SHA-256 of file content. If an image is moved or renamed, its identity (and collection memberships) are preserved. `path` is a mutable cached field, reconciled on detection.

**Manual + smart collections**: Manual collections use the join table. Smart collections store a JSON filter in `smart_query` and are evaluated at query time (no materialized membership).

**Agent interface**: The agent operates through tool functions, not raw SQL:
- `createCollection(name, description)`
- `addToCollection(collectionId, imageId)`
- `removeFromCollection(collectionId, imageId)`
- `listCollection(collectionId) -> Image[]`
- `getImageCollections(imageId) -> Collection[]`
- `searchImages(query) -> Image[]`

### iOS API

New gateway endpoints for the iOS app:

```
GET  /collections                    → list all collections
GET  /collections/:id               → collection detail + images
POST /collections                    → create collection
POST /collections/:id/images        → add image to collection
DELETE /collections/:id/images/:imgId → remove image from collection
```

## Implementation Plan

### Phase 1: JuiceFS + GCS (infra) ✅ done
- ✅ Sign up for JuiceFS cloud service (free tier)
- ✅ Verify mount + read/write on openclaw-001 and Fly.io

### Phase 2: Collections (server) ✅ done
- ✅ SQLite collections schema, CRUD, agent tools, gateway API endpoints

### Phase 3: Fly.io Migration ✅ done
- ✅ Custom Docker image with FUSE + JuiceFS pre-installed
- ✅ Sandbox provisioning via Fly.io Machines API
- ✅ JuiceFS mount in entrypoint.sh

### Phase 4: Self-hosted JuiceFS + AWS S3 Migration ✅ done (2026-03-25)
- ✅ Migrate from JuiceFS Cloud (GCS) to self-hosted JuiceFS (Supabase PG + AWS S3)
- ✅ Per-user PG role + S3 IAM isolation
- ✅ JuiceFS Cloud fully decommissioned
- See [juicefs-s3-migration-plan.md](juicefs-s3-migration-plan.md)

### Phase 5: API & iOS (gateway + client)
- iOS: collection list view, collection detail view
- iOS: add-to-collection action from image viewer

### Phase 6: Smart Collections (future)
- Define filter DSL (JSON-based)
- Implement query evaluator
- iOS: smart collection creation UI

## References

- [JuiceFS open source](https://github.com/juicedata/juicefs) — 13k+ stars, Go, Apache-2.0
- [JuiceFS docs](https://juicefs.com/docs/community/)
- [JuiceFS S3 migration plan](juicefs-s3-migration-plan.md) — full decision record for S3 over R2/GCS
- [Sandbox startup optimization](sandbox-startup-optimization.md) — cold start diagnosis and fixes
- [Fly.io Machines API](https://fly.io/docs/machines/overview/)
- Industry models: Apple Photos, Lightroom, PhotoPrism all use SQLite + join table for collections
- Existing image support: [docs/image-support.md](image-support.md)
