import type { Context } from 'hono'
import type { AuthUser } from './auth.js'
import { resolveSandboxUrl, provisionFlyMachine } from './sandbox.js'
import { getSandboxByUserId } from './db.js'
import { logError } from './log.js'

/**
 * GET /api/v1/sandbox/url
 *
 * Returns the sandbox access URL.
 * Auto-provisions a Fly.io machine if the user doesn't have one yet.
 *
 * Response:
 *   { ok: true, data: { url, expires_at, port, endpoints } }
 */
export async function getSandboxUrl(c: Context): Promise<Response> {
  const user = c.get('user') as AuthUser

  try {
    let resolved = await resolveSandboxUrl(user.id)

    // Auto-provision if no sandbox exists
    if (!resolved) {
      const result = await provisionFlyMachine(user.id)
      resolved = { url: result.signedUrl, machineId: result.sandbox.daytona_id }
    }

    // Get sandbox metadata for response
    const sandbox = await getSandboxByUserId(user.id)
    const port = sandbox?.port ?? 18800
    const expiresAt = sandbox?.signed_url_exp ?? null

    return c.json({
      ok: true,
      data: {
        url: resolved.url,
        expires_at: expiresAt,
        port,
        endpoints: {
          chat: '/chat',
          health: '/health',
          sessions: '/sessions',
          closet: '/closet',
        },
      },
    })
  } catch (err: any) {
    logError('sandbox-url', 'failed to resolve sandbox URL', err, { userId: user.id })
    return c.json({ ok: false, error: `Failed to get sandbox URL: ${err.message}` }, 500)
  }
}
