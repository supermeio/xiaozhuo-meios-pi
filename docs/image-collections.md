# Image Collections

> Design doc — 2026-03-15

## Motivation

Images are organized physically (directories), but vertical apps need logical grouping.
A wardrobe agent needs "Spring Outfits" and "Work Looks" collections where the same image
can appear in multiple places. File folders can't do this.

This is a platform-level capability that benefits any vertical agent, not just meio.

## Decision: SQLite on JuiceFS

SQLite database at `/persistent/.meios/collections.db`, stored on the JuiceFS mount.
Write amplification is negligible for our low-frequency collection operations.

Why SQLite over Supabase PG:
- **Co-located with data**: collections DB lives next to the images it references
- **No network round-trip**: queries are local disk reads (cached by JuiceFS)
- **Agent simplicity**: single file, no connection management
- **Portable**: backup = copy one file

## Schema

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

## Key Design Choices

**Content-hash identity**: `images.id` = SHA-256 of file content. If an image is moved or
renamed, its identity (and collection memberships) are preserved. `path` is a mutable cached
field, reconciled on detection.

**Manual + smart collections**: Manual collections use the join table. Smart collections store
a JSON filter in `smart_query` and are evaluated at query time (no materialized membership).

**Agent interface**: The agent operates through tool functions, not raw SQL:
- `createCollection(name, description)`
- `addToCollection(collectionId, imageId)`
- `removeFromCollection(collectionId, imageId)`
- `listCollection(collectionId) -> Image[]`
- `getImageCollections(imageId) -> Collection[]`
- `searchImages(query) -> Image[]`

## iOS API

Gateway endpoints for the iOS app:

```
GET  /collections                    → list all collections
GET  /collections/:id               → collection detail + images
POST /collections                    → create collection
POST /collections/:id/images        → add image to collection
DELETE /collections/:id/images/:imgId → remove image from collection
```

## Implementation Status

- ✅ SQLite schema, CRUD, agent tools, gateway API endpoints
- ✅ Auto-register images in `generate_image` tool
- Pending: iOS collection list/detail views
- Future: smart collections (JSON filter DSL)

## References

- [Persistent storage](persistent-storage.md) — JuiceFS infrastructure that hosts this DB
- [Image support](image-support.md) — image generation and delivery
- Industry models: Apple Photos, Lightroom, PhotoPrism all use SQLite + join table for collections
