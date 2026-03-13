import type { Context } from 'hono'
import type { AuthUser } from './auth.js'
import { resolveSignedUrl, provisionSandbox } from './sandbox.js'
import { getSandboxByUserId } from './db.js'
import { logError } from './log.js'

/**
 * GET /api/v1/sandbox/url
 *
 * Returns the signed preview URL for direct sandbox access.
 * Auto-provisions a sandbox if the user doesn't have one yet.
 *
 * Response:
 *   { ok: true, data: { url, expires_at, port, endpoints } }
 */
export async function getSandboxUrl(c: Context): Promise<Response> {
  const user = c.get('user') as AuthUser

  try {
    let signedUrl = await resolveSignedUrl(user.id)

    // Auto-provision if no sandbox exists
    if (!signedUrl) {
      const result = await provisionSandbox(user.id)
      signedUrl = result.signedUrl
    }

    // Get sandbox metadata for response
    const sandbox = await getSandboxByUserId(user.id)
    const port = sandbox?.port ?? 18800
    const expiresAt = sandbox?.signed_url_exp ?? null

    return c.json({
      ok: true,
      data: {
        url: signedUrl,
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
