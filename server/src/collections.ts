/**
 * Image Collections — SQLite-backed logical grouping for images.
 *
 * Provides a many-to-many relationship between images and collections,
 * backed by a single SQLite file at <workspace>/.meios/collections.db.
 *
 * Images are identified by content hash (SHA-256), so renames/moves
 * don't break collection membership.
 */

import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative, extname } from 'node:path'
import { randomUUID } from 'node:crypto'

// ── Types ──

export interface ImageRecord {
  id: string           // SHA-256 content hash
  path: string         // relative path from workspace root
  filename: string
  mime_type: string
  width: number | null
  height: number | null
  size_bytes: number
  created_at: string
  metadata: string | null  // JSON string
}

export interface Collection {
  id: string
  name: string
  description: string | null
  cover_image_id: string | null
  collection_type: 'manual' | 'smart'
  smart_query: string | null  // JSON string
  sort_order: string
  created_at: string
  updated_at: string
}

export interface CollectionImage {
  collection_id: string
  image_id: string
  position: number
  added_at: string
}

// ── Database singleton ──

let _db: Database.Database | null = null
let _workspaceRoot = ''

const SCHEMA = `
CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT DEFAULT 'image/webp',
    width INTEGER,
    height INTEGER,
    size_bytes INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    metadata TEXT
);

CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    cover_image_id TEXT REFERENCES images(id),
    collection_type TEXT DEFAULT 'manual',
    smart_query TEXT,
    sort_order TEXT DEFAULT 'added_at_desc',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collection_images (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,
    added_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (collection_id, image_id)
);

CREATE INDEX IF NOT EXISTS idx_images_path ON images(path);
CREATE INDEX IF NOT EXISTS idx_ci_image ON collection_images(image_id);
CREATE INDEX IF NOT EXISTS idx_ci_collection ON collection_images(collection_id);
`

export function initCollections(workspaceRoot: string): Database.Database {
  _workspaceRoot = workspaceRoot
  const meiosDir = resolve(workspaceRoot, '.meios')
  mkdirSync(meiosDir, { recursive: true })

  const dbPath = resolve(meiosDir, 'collections.db')
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  _db.exec(SCHEMA)
  return _db
}

function db(): Database.Database {
  if (!_db) throw new Error('Collections DB not initialized. Call initCollections() first.')
  return _db
}

// ── Image operations ──

/** Compute SHA-256 hash of a file */
export function hashFile(absPath: string): string {
  const content = readFileSync(absPath)
  return createHash('sha256').update(content).digest('hex')
}

/** MIME type from extension */
function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  }
  return map[ext.toLowerCase()] ?? 'application/octet-stream'
}

/** Register an image in the database. Returns the image record. */
export function registerImage(absPath: string, metadata?: Record<string, unknown>): ImageRecord {
  const relPath = relative(_workspaceRoot, absPath)
  const hash = hashFile(absPath)
  const stat = statSync(absPath)
  const ext = extname(absPath)

  const existing = db().prepare('SELECT * FROM images WHERE id = ?').get(hash) as ImageRecord | undefined
  if (existing) {
    // Update path if changed (file was moved/renamed)
    if (existing.path !== relPath) {
      db().prepare('UPDATE images SET path = ?, filename = ? WHERE id = ?')
        .run(relPath, absPath.split('/').pop()!, hash)
    }
    return { ...existing, path: relPath }
  }

  const record: ImageRecord = {
    id: hash,
    path: relPath,
    filename: absPath.split('/').pop()!,
    mime_type: mimeFromExt(ext),
    width: null,
    height: null,
    size_bytes: stat.size,
    created_at: new Date().toISOString(),
    metadata: metadata ? JSON.stringify(metadata) : null,
  }

  db().prepare(`
    INSERT INTO images (id, path, filename, mime_type, width, height, size_bytes, created_at, metadata)
    VALUES (@id, @path, @filename, @mime_type, @width, @height, @size_bytes, @created_at, @metadata)
  `).run(record)

  return record
}

/** Get an image by its hash ID */
export function getImage(imageId: string): ImageRecord | null {
  return (db().prepare('SELECT * FROM images WHERE id = ?').get(imageId) as ImageRecord) ?? null
}

/** Get an image by its file path (relative to workspace) */
export function getImageByPath(relPath: string): ImageRecord | null {
  return (db().prepare('SELECT * FROM images WHERE path = ?').get(relPath) as ImageRecord) ?? null
}

/** List all registered images */
export function listImages(): ImageRecord[] {
  return db().prepare('SELECT * FROM images ORDER BY created_at DESC').all() as ImageRecord[]
}

// ── Collection operations ──

/** Create a new collection */
export function createCollection(name: string, description?: string): Collection {
  const id = randomUUID()
  const now = new Date().toISOString()
  db().prepare(`
    INSERT INTO collections (id, name, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, description ?? null, now, now)

  return db().prepare('SELECT * FROM collections WHERE id = ?').get(id) as Collection
}

/** Get a collection by ID */
export function getCollection(collectionId: string): Collection | null {
  return (db().prepare('SELECT * FROM collections WHERE id = ?').get(collectionId) as Collection) ?? null
}

/** List all collections */
export function listCollections(): Collection[] {
  return db().prepare('SELECT * FROM collections ORDER BY updated_at DESC').all() as Collection[]
}

/** Update a collection's name and/or description */
export function updateCollection(collectionId: string, updates: { name?: string; description?: string }): Collection | null {
  const existing = getCollection(collectionId)
  if (!existing) return null

  const name = updates.name ?? existing.name
  const description = updates.description ?? existing.description
  const now = new Date().toISOString()
  db().prepare('UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE id = ?')
    .run(name, description, now, collectionId)

  return getCollection(collectionId)
}

/** Delete a collection (does NOT delete images) */
export function deleteCollection(collectionId: string): boolean {
  const result = db().prepare('DELETE FROM collections WHERE id = ?').run(collectionId)
  return result.changes > 0
}

// ── Collection membership ──

/** Add an image to a collection */
export function addToCollection(collectionId: string, imageId: string): boolean {
  const collection = getCollection(collectionId)
  if (!collection) return false
  const image = getImage(imageId)
  if (!image) return false

  // Get next position
  const maxPos = db().prepare(
    'SELECT COALESCE(MAX(position), -1) as max_pos FROM collection_images WHERE collection_id = ?'
  ).get(collectionId) as { max_pos: number }

  try {
    db().prepare(
      'INSERT INTO collection_images (collection_id, image_id, position) VALUES (?, ?, ?)'
    ).run(collectionId, imageId, maxPos.max_pos + 1)

    // Update collection timestamp
    db().prepare('UPDATE collections SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), collectionId)

    // Set as cover if first image
    if (maxPos.max_pos === -1) {
      db().prepare('UPDATE collections SET cover_image_id = ? WHERE id = ?')
        .run(imageId, collectionId)
    }

    return true
  } catch {
    // Already in collection (PRIMARY KEY constraint)
    return false
  }
}

/** Remove an image from a collection */
export function removeFromCollection(collectionId: string, imageId: string): boolean {
  const result = db().prepare(
    'DELETE FROM collection_images WHERE collection_id = ? AND image_id = ?'
  ).run(collectionId, imageId)

  if (result.changes > 0) {
    db().prepare('UPDATE collections SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), collectionId)
  }

  return result.changes > 0
}

/** List images in a collection */
export function listCollectionImages(collectionId: string): ImageRecord[] {
  return db().prepare(`
    SELECT i.* FROM images i
    JOIN collection_images ci ON ci.image_id = i.id
    WHERE ci.collection_id = ?
    ORDER BY ci.position ASC, ci.added_at ASC
  `).all(collectionId) as ImageRecord[]
}

/** List collections that contain a given image */
export function getImageCollections(imageId: string): Collection[] {
  return db().prepare(`
    SELECT c.* FROM collections c
    JOIN collection_images ci ON ci.collection_id = c.id
    WHERE ci.image_id = ?
    ORDER BY c.name ASC
  `).all(imageId) as Collection[]
}

/** Get collection with image count */
export function listCollectionsWithCounts(): (Collection & { image_count: number })[] {
  return db().prepare(`
    SELECT c.*, COUNT(ci.image_id) as image_count
    FROM collections c
    LEFT JOIN collection_images ci ON ci.collection_id = c.id
    GROUP BY c.id
    ORDER BY c.updated_at DESC
  `).all() as (Collection & { image_count: number })[]
}

// ── Scan & reconcile ──

/** Scan image directories and register any untracked images */
export function scanAndRegister(dirs: string[] = ['images', 'closet', 'looks']): number {
  let registered = 0
  const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

  for (const dir of dirs) {
    const absDir = resolve(_workspaceRoot, dir)
    if (!existsSync(absDir)) continue

    const scanDir = (dirPath: string) => {
      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        const fullPath = join(dirPath, entry.name)
        if (entry.isDirectory()) {
          scanDir(fullPath)
        } else if (imageExts.has(extname(entry.name).toLowerCase())) {
          const relPath = relative(_workspaceRoot, fullPath)
          const existing = getImageByPath(relPath)
          if (!existing) {
            registerImage(fullPath)
            registered++
          }
        }
      }
    }

    scanDir(absDir)
  }

  return registered
}
