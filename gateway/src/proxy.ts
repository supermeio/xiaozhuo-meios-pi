import type { Context } from 'hono'
import type { AuthUser } from './auth.js'
import type { Sandbox } from './db.js'
import { config } from './config.js'
import {
  resolveSandboxUrl,
  forceRefreshSignedUrl,
  provisionSandbox,
  provisionFlyMachine,
} from './sandbox.js'
import { logError } from './log.js'

// In-flight provision locks: prevents duplicate sandbox creation when
// concurrent requests arrive for the same user before a sandbox exists.
const provisionLocks = new Map<string, Promise<{ sandbox: Sandbox; signedUrl: string }>>()

/**
 * Proxy an authenticated request to the user's sandbox.
 *
 * Works with both Daytona and Fly.io backends, controlled by SANDBOX_PROVIDER env var.
 *
 * Flow:
 *   1. Resolve sandbox URL for user (auto-provisions if none exists)
 *   2. Forward request (method, path, headers, body)
 *   3. If 401/403 from sandbox → refresh URL → retry once (Daytona only)
 *   4. Return sandbox response (preserves { ok, data, error } envelope)
 */
export async function proxyToSandbox(c: Context): Promise<Response> {
  const user = c.get('user') as AuthUser
  let resolved = await resolveSandboxUrl(user.id)

  // Auto-provision sandbox for new users (with per-user lock to avoid duplicates)
  if (!resolved) {
    try {
      let pending = provisionLocks.get(user.id)
      if (!pending) {
        pending = config.sandboxProvider === 'flyio'
          ? provisionFlyMachine(user.id)
          : provisionSandbox(user.id)
        provisionLocks.set(user.id, pending)
        try {
          const result = await pending
          resolved = {
            url: result.signedUrl,
            machineId: config.sandboxProvider === 'flyio'
              ? result.sandbox.daytona_id
              : undefined,
          }
        } finally {
          provisionLocks.delete(user.id)
        }
      } else {
        const result = await pending
        resolved = {
          url: result.signedUrl,
          machineId: config.sandboxProvider === 'flyio'
            ? result.sandbox.daytona_id
            : undefined,
        }
      }
    } catch (err: any) {
      logError('proxy', 'auto-provision failed', err, { userId: user.id })
      return c.json(
        { ok: false, error: 'Failed to provision sandbox. Please try again later.' },
        503
      )
    }
  }

  // Build target URL: sandbox base + original path
  const path = c.req.path
  const targetUrl = resolved.url + path

  // Forward the request
  let response = await forwardRequest(c, targetUrl, resolved.machineId)

  // If sandbox returned 401/403, try refreshing the URL once (Daytona only)
  if (response.status === 401 || response.status === 403) {
    const refreshedUrl = await forceRefreshSignedUrl(user.id)
    if (refreshedUrl) {
      const retryUrl = refreshedUrl + path
      response = await forwardRequest(c, retryUrl, resolved.machineId)
    }
  }

  return response
}

async function forwardRequest(c: Context, targetUrl: string, machineId?: string): Promise<Response> {
  const method = c.req.method
  const headers = new Headers()

  // Forward content-type and accept headers
  const contentType = c.req.header('Content-Type')
  if (contentType) {
    headers.set('Content-Type', contentType)
  }
  const accept = c.req.header('Accept')
  if (accept) {
    headers.set('Accept', accept)
  }

  // Fly.io routing: force request to specific machine + auth secret
  if (machineId) {
    headers.set('fly-force-instance-id', machineId)
    headers.set('X-Gateway-Secret', config.flyio.gatewaySecret)
  }

  const init: RequestInit = { method, headers }

  // Forward body for methods that have one (with size limit)
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    const body = await c.req.text()
    if (body.length > 524288) { // 512 KB
      return c.json({ ok: false, error: 'Request body too large' }, 413)
    }
    init.body = body
  }

  try {
    const upstream = await fetch(targetUrl, init)

    const contentType = upstream.headers.get('Content-Type') ?? 'application/json'
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }

    // SSE: pipe through with explicit chunk flushing to avoid Cloud Run buffering
    if (contentType.includes('text/event-stream') && upstream.body) {
      const reader = upstream.body.getReader()
      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            return
          }
          controller.enqueue(value)
        },
        cancel() {
          reader.cancel()
        },
      })

      return new Response(stream, {
        status: upstream.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
          ...corsHeaders,
        },
      })
    }

    // Binary or text: buffer and forward
    const body = contentType.startsWith('image/') || contentType === 'application/octet-stream'
      ? await upstream.arrayBuffer()
      : await upstream.text()

    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': upstream.headers.get('Cache-Control') ?? '',
        ...corsHeaders,
      },
    })
  } catch (err: any) {
    return c.json(
      { ok: false, error: `Sandbox unreachable: ${err.message}` },
      502
    )
  }
}
