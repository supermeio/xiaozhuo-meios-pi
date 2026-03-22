/**
 * File sync: workspace → Cloudflare R2 via gateway presigned URLs
 *
 * Watches the workspace directory for file changes (add, change, delete)
 * and syncs them to R2 through the gateway's presigned URL flow.
 * On startup, performs a full reconcile to catch anything missed during
 * sandbox sleep.
 *
 * Architecture:
 *   chokidar (inotify) → debounce → gateway presign → PUT to R2
 *
 * The sandbox never holds R2 credentials. It authenticates to the gateway
 * with its per-machine GATEWAY_SECRET via X-Machine-Secret header, and
 * the gateway mints scoped presigned URLs for direct R2 upload.
 *
 * R2 key layout: {userId}/{relativePath}
 *   e.g. user-abc/closet/photos/white-shirt.jpg
 *        user-abc/outfits/2026-03-14/casual-spring.png
 */

import { watch } from 'chokidar'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

// ── Config ──

interface SyncConfig {
  workspacePath: string
  userId: string
  gatewayUrl: string       // e.g. https://api.meios.ai
  machineSecret: string    // per-machine GATEWAY_SECRET
  /** Subdirectories to watch (relative to workspace). Default: all */
  watchDirs?: string[]
  /** File extensions to sync. Default: images only */
  extensions?: string[]
}

const DEFAULT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']

// ── Gateway API helpers ──

async function gatewayFetch(
  config: SyncConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = `${config.gatewayUrl}${path}`
  const res = await fetch(url, {
    method,
    headers: {
      'X-Machine-Secret': config.machineSecret,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Gateway ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`)
  }
  return res
}

// ── Helpers ──

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

/**
 * Upload a file to R2 via gateway presigned URL.
 * 1. POST /internal/v1/sync/presign → get presigned PUT URL
 * 2. PUT file body directly to the presigned URL
 */
async function uploadFile(config: SyncConfig, relPath: string, filePath: string): Promise<void> {
  const contentType = getMimeType(filePath)

  // Step 1: get presigned URL from gateway
  const res = await gatewayFetch(config, 'POST', '/internal/v1/sync/presign', {
    path: relPath,
    contentType,
  })
  const json = await res.json() as { ok: boolean; data: { url: string } }
  const presignedUrl = json.data.url

  // Step 2: PUT file directly to R2
  const body = readFileSync(filePath)
  const putRes = await fetch(presignedUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
    },
    body,
    signal: AbortSignal.timeout(60000),
  })
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => '')
    throw new Error(`R2 PUT failed (${putRes.status}): ${text.slice(0, 200)}`)
  }
}

/**
 * Delete a file from R2 via gateway.
 */
async function deleteFile(config: SyncConfig, relPath: string): Promise<void> {
  await gatewayFetch(config, 'DELETE', `/internal/v1/sync/object?path=${encodeURIComponent(relPath)}`)
}

/**
 * List R2 objects via gateway.
 * Returns relative paths (without userId prefix).
 */
async function listRemoteFiles(config: SyncConfig, prefix: string): Promise<string[]> {
  const res = await gatewayFetch(config, 'GET', `/internal/v1/sync/list?prefix=${encodeURIComponent(prefix)}`)
  const json = await res.json() as { ok: boolean; data: { keys: string[] } }
  return json.data.keys
}

// ── Reconcile (startup full sync) ──

async function reconcile(config: SyncConfig): Promise<{ uploaded: number; deleted: number }> {
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

  // 2. List R2 objects for this user via gateway
  const r2Keys = new Set<string>()
  for (const dir of watchDirs) {
    const prefix = dir ? `${dir}/` : ''
    const keys = await listRemoteFiles(config, prefix)
    for (const key of keys) {
      r2Keys.add(key)
    }
  }

  // 3. Upload new local files (we can't compare mtimes via presigned flow,
  //    so upload all local files not yet in R2, plus re-upload all existing
  //    ones to be safe on first reconcile)
  for (const [relPath] of localFiles) {
    const fullPath = join(config.workspacePath, relPath)
    try {
      await uploadFile(config, relPath, fullPath)
      uploaded++
    } catch (err: any) {
      console.error(`[sync] upload failed: ${relPath}`, err.message)
    }
  }

  // 4. Delete R2 objects that no longer exist locally
  for (const key of r2Keys) {
    if (!localFiles.has(key)) {
      try {
        await deleteFile(config, key)
        deleted++
      } catch (err: any) {
        console.error(`[sync] delete failed: ${key}`, err.message)
      }
    }
  }

  return { uploaded, deleted }
}

// ── Watch (real-time sync) ──

function startWatcher(config: SyncConfig): ReturnType<typeof watch> {
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
    try {
      await uploadFile(config, relPath, filePath)
      console.log(`[sync] uploaded: ${relPath}`)
    } catch (err: any) {
      console.error(`[sync] upload failed: ${relPath}`, err.message)
    }
  })

  watcher.on('change', async (filePath: string) => {
    const relPath = relative(config.workspacePath, filePath)
    try {
      await uploadFile(config, relPath, filePath)
      console.log(`[sync] updated: ${relPath}`)
    } catch (err: any) {
      console.error(`[sync] update failed: ${relPath}`, err.message)
    }
  })

  watcher.on('unlink', async (filePath: string) => {
    const relPath = relative(config.workspacePath, filePath)
    try {
      await deleteFile(config, relPath)
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
 * Returns null if gateway URL or machine secret is not available (sync disabled).
 */
export async function initSync(workspacePath: string): Promise<{ stop: () => void } | null> {
  const gatewayUrl = process.env.MEIOS_GATEWAY_URL
  const machineSecret = process.env.GATEWAY_SECRET
  const userId = process.env.MEIOS_USER_ID

  if (!gatewayUrl || !machineSecret || !userId) {
    console.log('[sync] Gateway URL or machine secret not available, file sync disabled')
    return null
  }

  const config: SyncConfig = {
    workspacePath,
    userId,
    gatewayUrl,
    machineSecret,
    watchDirs: ['images'],
    extensions: DEFAULT_EXTENSIONS,
  }

  // Reconcile on startup
  console.log('[sync] reconciling workspace → R2...')
  try {
    const { uploaded, deleted } = await reconcile(config)
    console.log(`[sync] reconcile done: ${uploaded} uploaded, ${deleted} deleted`)
  } catch (err: any) {
    console.error('[sync] reconcile failed:', err.message)
    // Continue anyway — watcher will handle new changes
  }

  // Start real-time watcher
  const watcher = startWatcher(config)
  console.log(`[sync] watching ${config.watchDirs?.join(', ')} for changes`)

  return {
    stop: () => {
      watcher.close()
    },
  }
}

/**
 * Upload a single file to R2 immediately (bypasses watcher debounce).
 * Used by chatStream to ensure an image is on CDN before sending the URL to the client.
 * Returns true if uploaded successfully, false if sync is not configured.
 */
export async function ensureUploaded(workspacePath: string, relPath: string): Promise<boolean> {
  const gatewayUrl = process.env.MEIOS_GATEWAY_URL
  const machineSecret = process.env.GATEWAY_SECRET
  const userId = process.env.MEIOS_USER_ID
  if (!gatewayUrl || !machineSecret || !userId) return false

  const fullPath = join(workspacePath, relPath)
  if (!existsSync(fullPath)) return false

  const config: SyncConfig = { workspacePath, userId, gatewayUrl, machineSecret }
  await uploadFile(config, relPath, fullPath)
  return true
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
