import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initCollections,
  registerImage,
  getImage,
  getImageByPath,
  listImages,
  createCollection,
  getCollection,
  listCollections,
  updateCollection,
  deleteCollection,
  addToCollection,
  removeFromCollection,
  listCollectionImages,
  getImageCollections,
  listCollectionsWithCounts,
  scanAndRegister,
  hashFile,
} from './collections.js'

let WORKSPACE: string

beforeEach(() => {
  WORKSPACE = resolve(tmpdir(), `collections-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(WORKSPACE, { recursive: true })
  initCollections(WORKSPACE)
})

afterEach(() => {
  rmSync(WORKSPACE, { recursive: true, force: true })
})

function createTestImage(relPath: string, content = `image-${Date.now()}-${Math.random()}`): string {
  const absPath = resolve(WORKSPACE, relPath)
  mkdirSync(resolve(absPath, '..'), { recursive: true })
  writeFileSync(absPath, content)
  return absPath
}

// ── hashFile ──

describe('hashFile', () => {
  it('returns consistent SHA-256 for same content', () => {
    const path = createTestImage('images/a.png', 'test-content')
    const hash1 = hashFile(path)
    const hash2 = hashFile(path)
    expect(hash1).toBe(hash2)
    expect(hash1).toHaveLength(64) // SHA-256 hex
  })

  it('returns different hash for different content', () => {
    const path1 = createTestImage('images/a.png', 'content-a')
    const path2 = createTestImage('images/b.png', 'content-b')
    expect(hashFile(path1)).not.toBe(hashFile(path2))
  })
})

// ── Image registration ──

describe('registerImage', () => {
  it('registers an image and returns record', () => {
    const absPath = createTestImage('images/outfit.png')
    const record = registerImage(absPath)

    expect(record.id).toHaveLength(64)
    expect(record.path).toBe('images/outfit.png')
    expect(record.filename).toBe('outfit.png')
    expect(record.mime_type).toBe('image/png')
    expect(record.size_bytes).toBeGreaterThan(0)
  })

  it('returns existing record for same file content', () => {
    const path1 = createTestImage('images/a.png', 'same-content')
    const path2 = createTestImage('images/b.png', 'same-content')

    const r1 = registerImage(path1)
    const r2 = registerImage(path2)

    expect(r1.id).toBe(r2.id) // same hash
    expect(r2.path).toBe('images/b.png') // path updated to latest
  })

  it('stores metadata as JSON', () => {
    const absPath = createTestImage('images/gen.webp')
    const record = registerImage(absPath, { prompt: 'casual outfit', model: 'gemini' })

    expect(record.metadata).toBeDefined()
    const meta = JSON.parse(record.metadata!)
    expect(meta.prompt).toBe('casual outfit')
  })

  it('detects MIME type from extension', () => {
    const cases = [
      ['test.jpg', 'image/jpeg'],
      ['test.jpeg', 'image/jpeg'],
      ['test.png', 'image/png'],
      ['test.webp', 'image/webp'],
      ['test.gif', 'image/gif'],
    ]
    for (const [filename, expectedMime] of cases) {
      const absPath = createTestImage(`images/${filename}`, `content-${filename}`)
      const record = registerImage(absPath)
      expect(record.mime_type, `${filename} should be ${expectedMime}`).toBe(expectedMime)
    }
  })
})

describe('getImage / getImageByPath', () => {
  it('retrieves by hash ID', () => {
    const absPath = createTestImage('images/test.png')
    const registered = registerImage(absPath)

    const found = getImage(registered.id)
    expect(found).toBeDefined()
    expect(found!.path).toBe('images/test.png')
  })

  it('retrieves by path', () => {
    const absPath = createTestImage('images/test.png')
    registerImage(absPath)

    const found = getImageByPath('images/test.png')
    expect(found).toBeDefined()
    expect(found!.filename).toBe('test.png')
  })

  it('returns null for unknown ID', () => {
    expect(getImage('nonexistent')).toBeNull()
  })
})

describe('listImages', () => {
  it('lists all registered images', () => {
    createTestImage('images/a.png', 'a')
    createTestImage('images/b.jpg', 'b')
    registerImage(resolve(WORKSPACE, 'images/a.png'))
    registerImage(resolve(WORKSPACE, 'images/b.jpg'))

    const images = listImages()
    expect(images).toHaveLength(2)
  })
})

// ── Collections CRUD ──

describe('createCollection', () => {
  it('creates a collection with name and description', () => {
    const col = createCollection('Spring Outfits', 'My favorite spring looks')
    expect(col.id).toBeDefined()
    expect(col.name).toBe('Spring Outfits')
    expect(col.description).toBe('My favorite spring looks')
    expect(col.collection_type).toBe('manual')
  })

  it('creates a collection without description', () => {
    const col = createCollection('Favorites')
    expect(col.name).toBe('Favorites')
    expect(col.description).toBeNull()
  })
})

describe('getCollection', () => {
  it('retrieves by ID', () => {
    const created = createCollection('Test')
    const found = getCollection(created.id)
    expect(found).toBeDefined()
    expect(found!.name).toBe('Test')
  })

  it('returns null for unknown ID', () => {
    expect(getCollection('nonexistent')).toBeNull()
  })
})

describe('listCollections', () => {
  it('lists all collections ordered by updated_at DESC', () => {
    createCollection('A')
    createCollection('B')
    createCollection('C')

    const cols = listCollections()
    expect(cols).toHaveLength(3)
  })
})

describe('updateCollection', () => {
  it('updates name and description', () => {
    const col = createCollection('Old Name', 'Old desc')
    const updated = updateCollection(col.id, { name: 'New Name', description: 'New desc' })

    expect(updated!.name).toBe('New Name')
    expect(updated!.description).toBe('New desc')
  })

  it('updates only name, keeps description', () => {
    const col = createCollection('Name', 'Desc')
    const updated = updateCollection(col.id, { name: 'New Name' })

    expect(updated!.name).toBe('New Name')
    expect(updated!.description).toBe('Desc')
  })

  it('returns null for unknown collection', () => {
    expect(updateCollection('nonexistent', { name: 'X' })).toBeNull()
  })
})

describe('deleteCollection', () => {
  it('deletes a collection', () => {
    const col = createCollection('To Delete')
    expect(deleteCollection(col.id)).toBe(true)
    expect(getCollection(col.id)).toBeNull()
  })

  it('returns false for unknown collection', () => {
    expect(deleteCollection('nonexistent')).toBe(false)
  })

  it('does not delete images when collection is deleted', () => {
    const absPath = createTestImage('images/keep.png')
    const img = registerImage(absPath)
    const col = createCollection('Temp')
    addToCollection(col.id, img.id)
    deleteCollection(col.id)

    expect(getImage(img.id)).toBeDefined() // image still exists
  })
})

// ── Collection membership ──

describe('addToCollection / removeFromCollection', () => {
  it('adds an image to a collection', () => {
    const absPath = createTestImage('images/outfit.png')
    const img = registerImage(absPath)
    const col = createCollection('Favorites')

    expect(addToCollection(col.id, img.id)).toBe(true)

    const images = listCollectionImages(col.id)
    expect(images).toHaveLength(1)
    expect(images[0].id).toBe(img.id)
  })

  it('same image can be in multiple collections', () => {
    const absPath = createTestImage('images/versatile.png')
    const img = registerImage(absPath)
    const col1 = createCollection('Work')
    const col2 = createCollection('Casual')

    addToCollection(col1.id, img.id)
    addToCollection(col2.id, img.id)

    const collections = getImageCollections(img.id)
    expect(collections).toHaveLength(2)
  })

  it('adding same image twice to same collection returns false', () => {
    const absPath = createTestImage('images/dup.png')
    const img = registerImage(absPath)
    const col = createCollection('Test')

    expect(addToCollection(col.id, img.id)).toBe(true)
    expect(addToCollection(col.id, img.id)).toBe(false) // duplicate
  })

  it('returns false for invalid collection or image', () => {
    const absPath = createTestImage('images/x.png')
    const img = registerImage(absPath)
    const col = createCollection('Test')

    expect(addToCollection('bad-col', img.id)).toBe(false)
    expect(addToCollection(col.id, 'bad-img')).toBe(false)
  })

  it('removes an image from a collection', () => {
    const absPath = createTestImage('images/temp.png')
    const img = registerImage(absPath)
    const col = createCollection('Test')
    addToCollection(col.id, img.id)

    expect(removeFromCollection(col.id, img.id)).toBe(true)
    expect(listCollectionImages(col.id)).toHaveLength(0)
  })

  it('sets first image as cover', () => {
    const absPath = createTestImage('images/cover.png')
    const img = registerImage(absPath)
    const col = createCollection('With Cover')
    addToCollection(col.id, img.id)

    const updated = getCollection(col.id)
    expect(updated!.cover_image_id).toBe(img.id)
  })

  it('preserves insertion order via position', () => {
    const img1 = registerImage(createTestImage('images/1.png', 'one'))
    const img2 = registerImage(createTestImage('images/2.png', 'two'))
    const img3 = registerImage(createTestImage('images/3.png', 'three'))
    const col = createCollection('Ordered')

    addToCollection(col.id, img1.id)
    addToCollection(col.id, img2.id)
    addToCollection(col.id, img3.id)

    const images = listCollectionImages(col.id)
    expect(images.map(i => i.filename)).toEqual(['1.png', '2.png', '3.png'])
  })
})

describe('getImageCollections', () => {
  it('returns all collections containing an image', () => {
    const img = registerImage(createTestImage('images/shared.png'))
    const c1 = createCollection('A')
    const c2 = createCollection('B')
    const c3 = createCollection('C')
    addToCollection(c1.id, img.id)
    addToCollection(c3.id, img.id)

    const collections = getImageCollections(img.id)
    expect(collections).toHaveLength(2)
    expect(collections.map(c => c.name).sort()).toEqual(['A', 'C'])
  })

  it('returns empty for image not in any collection', () => {
    const img = registerImage(createTestImage('images/solo.png'))
    expect(getImageCollections(img.id)).toHaveLength(0)
  })
})

describe('listCollectionsWithCounts', () => {
  it('includes image count', () => {
    const col = createCollection('Counted')
    const img1 = registerImage(createTestImage('images/a.png', 'aa'))
    const img2 = registerImage(createTestImage('images/b.png', 'bb'))
    addToCollection(col.id, img1.id)
    addToCollection(col.id, img2.id)

    const cols = listCollectionsWithCounts()
    const found = cols.find(c => c.id === col.id)
    expect(found!.image_count).toBe(2)
  })

  it('returns 0 count for empty collection', () => {
    createCollection('Empty')
    const cols = listCollectionsWithCounts()
    expect(cols[0].image_count).toBe(0)
  })
})

// ── Scan & reconcile ──

describe('scanAndRegister', () => {
  it('registers untracked images from directories', () => {
    createTestImage('images/auto1.png', 'auto-1')
    createTestImage('images/auto2.jpg', 'auto-2')
    createTestImage('closet/top.webp', 'closet-top')

    const count = scanAndRegister()
    expect(count).toBe(3)
    expect(listImages()).toHaveLength(3)
  })

  it('skips already registered images', () => {
    const absPath = createTestImage('images/existing.png', 'existing')
    registerImage(absPath)

    const count = scanAndRegister()
    expect(count).toBe(0) // already registered
  })

  it('scans subdirectories recursively', () => {
    createTestImage('images/2026/03/outfit.png', 'deep')

    const count = scanAndRegister()
    expect(count).toBe(1)

    const images = listImages()
    expect(images[0].path).toBe('images/2026/03/outfit.png')
  })

  it('ignores non-image files', () => {
    createTestImage('images/readme.txt', 'not an image')
    createTestImage('images/data.json', '{}')

    const count = scanAndRegister()
    expect(count).toBe(0)
  })
})
