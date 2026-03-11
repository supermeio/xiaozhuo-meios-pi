import type { Context } from 'hono'
import type { AuthUser } from './auth.js'
import type { Sandbox } from './db.js'
import { resolveSignedUrl, forceRefreshSignedUrl, provisionSandbox, rotateTokenIfNeeded } from './sandbox.js'
import { getSandboxByUserId } from './db.js'
import { logError } from './log.js'

// In-flight provision locks: prevents duplicate sandbox creation when
// concurrent requests arrive for the same user before a sandbox exists.
const provisionLocks = new Map<string, Promise<{ sandbox: Sandbox; signedUrl: string }>>()

/**
 * Proxy an authenticated request to the user's Daytona sandbox.
 *
 * Flow:
 *   1. Resolve signed URL for user (auto-provisions if none exists)
 *   2. Forward request (method, path, headers, body)
 *   3. If 401/403 from sandbox → refresh signed URL → retry once
 *   4. Return sandbox response (preserves { ok, data, error } envelope)
 */
export async function proxyToSandbox(c: Context): Promise<Response> {
  const user = c.get('user') as AuthUser
  let signedUrl = await resolveSignedUrl(user.id)

  // Auto-provision sandbox for new users (with per-user lock to avoid duplicates)
  if (!signedUrl) {
    try {
      let pending = provisionLocks.get(user.id)
      if (!pending) {
        pending = provisionSandbox(user.id)
        provisionLocks.set(user.id, pending)
        try {
          const result = await pending
          signedUrl = result.signedUrl
        } finally {
          provisionLocks.delete(user.id)
        }
      } else {
        const result = await pending
        signedUrl = result.signedUrl
      }
    } catch (err: any) {
      logError('proxy', 'auto-provision failed', err, { userId: user.id })
      return c.json(
        { ok: false, error: 'Failed to provision sandbox. Please try again later.' },
        503
      )
    }
  }

  // Check if sandbox token needs rotation (fire-and-forget, doesn't block)
  const sandbox = await getSandboxByUserId(user.id)
  if (sandbox) rotateTokenIfNeeded(sandbox)

  // Build target URL: signed base + original path
  const path = c.req.path
  const targetUrl = signedUrl + path

  // Forward the request
  let response = await forwardRequest(c, targetUrl)

  // If sandbox returned 401/403, try refreshing the signed URL once
  if (response.status === 401 || response.status === 403) {
    const refreshedUrl = await forceRefreshSignedUrl(user.id)
    if (refreshedUrl) {
      const retryUrl = refreshedUrl + path
      response = await forwardRequest(c, retryUrl)
    }
  }

  return response
}

async function forwardRequest(c: Context, targetUrl: string): Promise<Response> {
  const method = c.req.method
  const headers = new Headers()

  // Forward content-type for POST/PUT/PATCH
  const contentType = c.req.header('Content-Type')
  if (contentType) {
    headers.set('Content-Type', contentType)
  }

  const init: RequestInit = { method, headers }

  // Forward body for methods that have one
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    init.body = await c.req.text()
  }

  try {
    const upstream = await fetch(targetUrl, init)

    // Pass through the response as-is (preserves { ok, data, error } envelope)
    const body = await upstream.text()
    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    })
  } catch (err: any) {
    return c.json(
      { ok: false, error: `Sandbox unreachable: ${err.message}` },
      502
    )
  }
}
