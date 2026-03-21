/**
 * File sync: workspace → Cloudflare R2
 *
 * Watches the workspace directory for file changes (add, change, delete)
 * and syncs them to an R2 bucket. On startup, performs a full reconcile
 * to catch anything missed during sandbox sleep.
 *
 * Architecture:
 *   chokidar (inotify) → debounce → S3 PutObject/DeleteObject → R2
 *
 * R2 key layout: {userId}/{relativePath}
 *   e.g. user-abc/closet/photos/white-shirt.jpg
 *        user-abc/outfits/2026-03-14/casual-spring.png
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { watch } from 'chokidar'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

// ── Config ──

interface SyncConfig {
  workspacePath: string
  userId: string
  bucket: string
  endpoint: string         // https://{accountId}.r2.cloudflarestorage.com
  accessKeyId: string
  secretAccessKey: string
  /** Subdirectories to watch (relative to workspace). Default: all */
  watchDirs?: string[]
  /** File extensions to sync. Default: images only */
  extensions?: string[]
}

const DEFAULT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']

// ── S3 Client ──

function createR2Client(config: SyncConfig): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
}

// ── Helpers ──

function r2Key(userId: string, relPath: string): string {
  return `${userId}/${relPath}`
}

function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const types: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  }
  return types[ext] ?? 'application/octet-stream'
}

function shouldSync(filePath: string, extensions: string[]): boolean {
  return extensions.some(ext => filePath.toLowerCase().endsWith(ext))
}

// ── Sync Operations ──

async function uploadFile(client: S3Client, bucket: string, key: string, filePath: string): Promise<void> {
  const body = readFileSync(filePath)
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: getMimeType(filePath),
    CacheControl: 'public, max-age=86400',
  }))
}

async function deleteFile(client: S3Client, bucket: string, key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  }))
}

// ── Reconcile (startup full sync) ──

async function reconcile(client: S3Client, config: SyncConfig): Promise<{ uploaded: number; deleted: number }> {
  const extensions = config.extensions ?? DEFAULT_EXTENSIONS
  let uploaded = 0
  let deleted = 0

  // 1. Scan local files
  const localFiles = new Map<string, number>() // relPath → mtime
  function scanDir(dir: string) {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        scanDir(fullPath)
      } else if (shouldSync(entry.name, extensions)) {
        const relPath = relative(config.workspacePath, fullPath)
        localFiles.set(relPath, statSync(fullPath).mtimeMs)
      }
    }
  }

  const watchDirs = config.watchDirs ?? ['']
  for (const dir of watchDirs) {
    scanDir(join(config.workspacePath, dir))
  }

  // 2. List R2 objects for this user
  const r2Files = new Map<string, Date>() // relPath → lastModified
  let continuationToken: string | undefined
  do {
    const list = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: `${config.userId}/`,
      ContinuationToken: continuationToken,
    }))
    for (const obj of list.Contents ?? []) {
      const relPath = obj.Key!.slice(`${config.userId}/`.length)
      r2Files.set(relPath, obj.LastModified ?? new Date(0))
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined
  } while (continuationToken)

  // 3. Upload new or modified local files
  for (const [relPath, mtime] of localFiles) {
    const r2Modified = r2Files.get(relPath)
    if (!r2Modified || mtime > r2Modified.getTime()) {
      const fullPath = join(config.workspacePath, relPath)
      const key = r2Key(config.userId, relPath)
      try {
        await uploadFile(client, config.bucket, key, fullPath)
        uploaded++
      } catch (err: any) {
        console.error(`[sync] upload failed: ${relPath}`, err.message)
      }
    }
  }

  // 4. Delete R2 objects that no longer exist locally
  for (const relPath of r2Files.keys()) {
    if (!localFiles.has(relPath)) {
      const key = r2Key(config.userId, relPath)
      try {
        await deleteFile(client, config.bucket, key)
        deleted++
      } catch (err: any) {
        console.error(`[sync] delete failed: ${relPath}`, err.message)
      }
    }
  }

  return { uploaded, deleted }
}

// ── Watch (real-time sync) ──

function startWatcher(client: S3Client, config: SyncConfig): ReturnType<typeof watch> {
  const extensions = config.extensions ?? DEFAULT_EXTENSIONS
  const watchPaths = (config.watchDirs ?? ['']).map(d => join(config.workspacePath, d))

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500 },
    ignored: (path: string) => {
      // Ignore non-syncable files (but allow directories)
      if (existsSync(path) && statSync(path).isDirectory()) return false
      return !shouldSync(path, extensions)
    },
  })

  watcher.on('add', async (filePath: string) => {
    const relPath = relative(config.workspacePath, filePath)
    const key = r2Key(config.userId, relPath)
    try {
      await uploadFile(client, config.bucket, key, filePath)
      console.log(`[sync] uploaded: ${relPath}`)
    } catch (err: any) {
      console.error(`[sync] upload failed: ${relPath}`, err.message)
    }
  })

  watcher.on('change', async (filePath: string) => {
    const relPath = relative(config.workspacePath, filePath)
    const key = r2Key(config.userId, relPath)
    try {
      await uploadFile(client, config.bucket, key, filePath)
      console.log(`[sync] updated: ${relPath}`)
    } catch (err: any) {
      console.error(`[sync] update failed: ${relPath}`, err.message)
    }
  })

  watcher.on('unlink', async (filePath: string) => {
    const relPath = relative(config.workspacePath, filePath)
    const key = r2Key(config.userId, relPath)
    try {
      await deleteFile(client, config.bucket, key)
      console.log(`[sync] deleted: ${relPath}`)
    } catch (err: any) {
      console.error(`[sync] delete failed: ${relPath}`, err.message)
    }
  })

  return watcher
}

// ── Public API ──

/**
 * Initialize file sync. Call once at server startup.
 * Returns null if R2 config is not available (sync disabled).
 */
export async function initSync(workspacePath: string): Promise<{ stop: () => void } | null> {
  const endpoint = process.env.R2_ENDPOINT
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucket = process.env.R2_BUCKET ?? 'meios-images'
  const userId = process.env.MEIOS_USER_ID

  if (!endpoint || !accessKeyId || !secretAccessKey || !userId) {
    console.log('[sync] R2 config not available, file sync disabled')
    return null
  }

  const config: SyncConfig = {
    workspacePath,
    userId,
    bucket,
    endpoint,
    accessKeyId,
    secretAccessKey,
    watchDirs: ['closet', 'images', 'looks'],
    extensions: DEFAULT_EXTENSIONS,
  }

  const client = createR2Client(config)

  // Reconcile on startup
  console.log('[sync] reconciling workspace → R2...')
  try {
    const { uploaded, deleted } = await reconcile(client, config)
    console.log(`[sync] reconcile done: ${uploaded} uploaded, ${deleted} deleted`)
  } catch (err: any) {
    console.error('[sync] reconcile failed:', err.message)
    // Continue anyway — watcher will handle new changes
  }

  // Start real-time watcher
  const watcher = startWatcher(client, config)
  console.log(`[sync] watching ${config.watchDirs?.join(', ')} for changes`)

  return {
    stop: () => {
      watcher.close()
      client.destroy()
    },
  }
}

/**
 * Get the public URL for a synced file.
 * Returns null if R2 is not configured.
 */
export function getImageUrl(userId: string, relativePath: string): string | null {
  const publicBase = process.env.R2_PUBLIC_URL // e.g. https://images.meios.ai
  if (!publicBase) return null
  return `${publicBase}/${userId}/${relativePath}`
}
