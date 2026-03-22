/**
 * Sandbox-to-gateway sync API: presigned URL flow for R2 uploads.
 *
 * Sandboxes authenticate with X-Machine-Secret, and the gateway
 * mints scoped presigned URLs so raw R2 credentials never leave
 * the trusted gateway.
 */

import type { Context, Next } from 'hono'
import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { config } from './config.js'
import { getSandboxByMachineSecret } from './db.js'

// ── Middleware ──

/**
 * Authenticate sandbox by X-Machine-Secret header.
 * Sets 'sandboxUserId' in the Hono context.
 */
export async function sandboxAuthMiddleware(c: Context, next: Next) {
  const secret = c.req.header('X-Machine-Secret')
  if (!secret) {
    return c.json({ ok: false, error: 'Missing X-Machine-Secret header' }, 401)
  }

  const sandbox = await getSandboxByMachineSecret(secret)
  if (!sandbox) {
    return c.json({ ok: false, error: 'Invalid machine secret' }, 401)
  }

  c.set('sandboxUserId', sandbox.user_id)
  return next()
}

// ── R2 Client ──

let _r2Client: S3Client | null = null

function getR2Client(): S3Client {
  if (!_r2Client) {
    if (!config.r2) {
      throw new Error('R2 config not available')
    }
    _r2Client = new S3Client({
      region: 'auto',
      endpoint: config.r2.endpoint,
      credentials: {
        accessKeyId: config.r2.accessKeyId,
        secretAccessKey: config.r2.secretAccessKey,
      },
    })
  }
  return _r2Client
}

function getBucket(): string {
  return config.r2?.bucket ?? 'meios-images'
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

// ── Route Handlers ──

const PRESIGN_EXPIRES_IN = 600 // 10 minutes

/**
 * POST /internal/v1/sync/presign
 * Body: { path: string, contentType?: string }
 * Returns: { ok: true, data: { url: string, key: string, expiresIn: number } }
 *
 * The sandbox PUTs the file body directly to the returned presigned URL.
 */
export async function presignUpload(c: Context) {
  const userId = c.get('sandboxUserId') as string
  const body = await c.req.json<{ path: string; contentType?: string }>()
  const { path } = body

  if (!path || typeof path !== 'string') {
    return c.json({ ok: false, error: 'Missing or invalid path' }, 400)
  }

  const key = `${userId}/${path}`
  const contentType = body.contentType ?? getMimeType(path)

  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    ContentType: contentType,
    CacheControl: 'public, max-age=86400',
  })

  const url = await getSignedUrl(getR2Client(), command, {
    expiresIn: PRESIGN_EXPIRES_IN,
  })

  return c.json({
    ok: true,
    data: { url, key, expiresIn: PRESIGN_EXPIRES_IN },
  })
}

/**
 * DELETE /internal/v1/sync/object?path=images/foo.png
 * Deletes the object from R2 (scoped to the sandbox's user).
 */
export async function deleteObject(c: Context) {
  const userId = c.get('sandboxUserId') as string
  const path = c.req.query('path')

  if (!path) {
    return c.json({ ok: false, error: 'Missing path query parameter' }, 400)
  }

  const key = `${userId}/${path}`

  await getR2Client().send(new DeleteObjectCommand({
    Bucket: getBucket(),
    Key: key,
  }))

  return c.json({ ok: true })
}

/**
 * GET /internal/v1/sync/list?prefix=images/
 * Lists R2 objects under the user's prefix.
 * Returns: { ok: true, data: { keys: string[] } }
 */
export async function listObjects(c: Context) {
  const userId = c.get('sandboxUserId') as string
  const prefix = c.req.query('prefix') ?? ''

  const fullPrefix = `${userId}/${prefix}`
  const keys: string[] = []
  let continuationToken: string | undefined

  do {
    const result = await getR2Client().send(new ListObjectsV2Command({
      Bucket: getBucket(),
      Prefix: fullPrefix,
      ContinuationToken: continuationToken,
    }))
    for (const obj of result.Contents ?? []) {
      // Strip the userId prefix so the sandbox sees relative paths
      const relKey = obj.Key!.slice(`${userId}/`.length)
      keys.push(relKey)
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined
  } while (continuationToken)

  return c.json({ ok: true, data: { keys } })
}
