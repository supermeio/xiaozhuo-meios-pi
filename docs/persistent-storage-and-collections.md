# Persistent Storage & Image Collections

> Design doc — 2026-03-15

## Motivation

meios gives each vertical agent (meio, etc.) a Daytona sandbox with full filesystem access. The agent can create, read, update, and delete images freely. But two gaps remain:

1. **Persistence**: Sandbox filesystems are ephemeral. If a sandbox is destroyed or rebuilt, generated images are lost. The current R2 sync provides a backup, but there's no built-in "persistent filesystem" that survives sandbox lifecycle events with near-zero cold start cost.

2. **Collections**: Images are organized physically (directories), but vertical apps need logical grouping. A wardrobe agent needs "Spring Outfits" and "Work Looks" collections where the same image can appear in multiple places. File folders can't do this.

Both are platform-level capabilities that benefit any vertical agent, not just meio.

## Decision: JuiceFS + GCS + SQLite Collections

### Why JuiceFS (Route C)

We evaluated three approaches:

| Route | Approach | Cold Start | Infra Cost | Agent Transparency |
|-------|----------|-----------|------------|-------------------|
| **A** | Daytona Volumes | <1s | None | Full |
| **B** | R2 API + lazy restore | <1s (db) + on-demand images | None | Partial (needs tool awareness) |
| **C** | JuiceFS + GCS | <1s (FUSE mount) + on-demand | Metadata engine | Full |

Route C was chosen because:
- **Agent transparency**: the agent sees a normal POSIX filesystem. No special tools needed for persistence — files written to the mount are automatically durable.
- **iCloud-like UX**: mount is instant, file content loads on first access, local cache makes repeated access fast.
- **Platform value**: this is infrastructure meios provides to all vertical agents, not a per-app hack.

Route A was rejected because Daytona Volumes can't run SQLite (no block storage semantics). Route B works but requires every agent to understand lazy-loading — we'd rather make persistence invisible.

### Why GCS over R2

We initially planned to use Cloudflare R2 as the object storage backend. During setup we discovered:
- JuiceFS Cloud Service does not list Cloudflare R2 as a provider
- JuiceFS Community Edition supports R2 (via S3-compatible API), but with limitations: `gc`, `fsck`, `sync`, `destroy` don't work because R2's ListObjects is not sorted
- Self-deploying JuiceFS with R2 requires running a metadata engine (Redis), adding operational complexity

GCS was chosen instead because:
- JuiceFS Cloud Service natively supports GCP — zero configuration friction
- Our gateway already runs on GCP Cloud Run (us-central) — same cloud, low latency
- GCS egress costs are manageable for initial phase; for production we add Cloudflare CDN as a reverse proxy in front of GCS (zero egress via Cloudflare caching)

### Image Delivery to iOS App

```
Agent writes → JuiceFS (GCS) → Cloudflare CDN → iOS app reads
                                  ↑
                          images.meios.ai CNAME
                          (caches GCS, zero egress)
```

- **Storage**: GCS (via JuiceFS) — single source of truth
- **Delivery**: Cloudflare CDN reverse-proxies GCS — images are cacheable (immutable, high hit rate)
- **R2 phase-out**: existing R2 sync can be deprecated once GCS + CDN is live

### Architecture

```
┌──────────────────────────────────┐
│      Daytona Sandbox             │
│                                  │
│  /workspace/        (ephemeral)  │  ← agent code, temp files
│  /persistent/       (JuiceFS)    │  ← images, collections.db
│    ├── .meios/collections.db     │
│    ├── images/                   │
│    ├── closet/                   │
│    └── looks/                    │
│                                  │
│  JuiceFS Client (FUSE mount)     │
└──────────┬───────────────────────┘
           │
     metadata ops ──→  JuiceFS Cloud Service (hosted, us-east4)
     data read/write ──→  Google Cloud Storage (us-east4)
```

### JuiceFS Cloud Service

For the initial phase, we use JuiceFS hosted cloud service (not self-deployed):
- **Free tier**: 1TB filesystem, up to 100 concurrent mounts — sufficient for trial
- **Pay-as-you-go** beyond free tier
- We provide our own GCS as the data backend; JuiceFS only manages metadata
- Volume name: `meios-persistent`, region: us-east4
- Trash expiration: 7 days (recover from accidental deletes)
- If we outgrow the hosted service or want full control, we can self-deploy with Redis as the metadata engine later

### GCP Configuration

- **Project**: `xiaozhuo-meios-pi`
- **Service Account**: `juicefs-storage@xiaozhuo-meios-pi.iam.gserviceaccount.com` (Storage Admin)
- **Auth**: JSON key file, set via `GOOGLE_APPLICATION_CREDENTIALS` env var at mount time
- **JuiceFS token**: stored in `.env.local` as `JUICEFS_ACCESS_KEY`

### Cold Start Flow

```
1. Sandbox starts                          (~2s, Daytona)
2. JuiceFS client mounts /persistent/      (<1s, FUSE + metadata connect)
3. Agent starts, sees all files instantly   (metadata from JuiceFS cloud)
4. First image access fetches from GCS     (+100-200ms, then cached locally)
```

Total perceived cold start: **<3s**, matching current Daytona cold start. No bulk restore needed.

### Verification (2026-03-15)

Successfully verified on openclaw-001 (dev VM):
- JuiceFS client v5.3.2 installed (Linux ARM64)
- Mounted `meios-persistent` at `/jfs`
- Write test: `hello.txt` (10 bytes) — confirmed visible in JuiceFS console
- Read test: content matches — full round-trip through GCS verified

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

### Phase 1: JuiceFS Mount (infra) ✅ partially done
- ✅ Sign up for JuiceFS cloud service (free tier)
- ✅ Create filesystem `meios-persistent` with GCS backend (us-east4)
- ✅ Create GCP service account with Storage Admin role
- ✅ Verify mount + read/write on openclaw-001
- Add JuiceFS client to Daytona sandbox image
- Configure mount at sandbox startup (`/persistent/`)
- Migrate image directories from `/workspace/` to `/persistent/`

### Phase 2: Collections (server) ✅ partially done
- ✅ Add `better-sqlite3` dependency to server
- ✅ Create collections.db schema initialization (`server/src/collections.ts`)
- ✅ Implement collection CRUD + image registration + scan/reconcile (36 tests passing)
- Implement collection tool functions for the agent (wrap collections.ts as pi-agent tools)
- Register image in DB on creation in `generate_image` tool (compute SHA-256)
- Add chokidar watcher to reconcile DB ↔ filesystem

### Phase 3: API & iOS (gateway + client)
- Add collection endpoints to server gateway
- iOS: collection list view, collection detail view
- iOS: add-to-collection action from image viewer

### Phase 4: Smart Collections (future)
- Define filter DSL (JSON-based)
- Implement query evaluator
- iOS: smart collection creation UI

### Phase 3: API & iOS (gateway + client)
- Add collection endpoints to server gateway
- iOS: collection list view, collection detail view
- iOS: add-to-collection action from image viewer

### Phase 4: CDN & Image Delivery
- Configure Cloudflare CDN reverse proxy for GCS
- Update iOS app to fetch images from CDN URL
- Deprecate R2 sync

### Phase 5: Smart Collections (future)
- Define filter DSL (JSON-based)
- Implement query evaluator
- iOS: smart collection creation UI

## References

- [JuiceFS Cloud Service](https://juicefs.com/en/product/cloud-service/)
- [JuiceFS Docs](https://juicefs.com/docs/cloud/)
- [JuiceFS + R2 limitations](https://github.com/juicedata/juicefs/issues/2155) — why we chose GCS over R2
- [Daytona Regions](https://www.daytona.io/docs/en/regions/) — sandbox defaults to us-east
- Industry models: Apple Photos, Lightroom, PhotoPrism all use SQLite + join table for collections
- Existing image support: [docs/image-support.md](image-support.md)
