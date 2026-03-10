import { createRemoteJWKSet, jwtVerify } from 'jose'
import { config } from './config.js'
import type { Context, Next } from 'hono'

// Remote JWKS — fetches and caches Supabase's public keys (ECC P-256)
const jwks = createRemoteJWKSet(new URL(config.supabase.jwksUrl))

export interface AuthUser {
  id: string
  email?: string
}

/**
 * Hono middleware: verify Supabase JWT from Authorization header.
 * Uses JWKS (asymmetric ECC P-256) verification.
 * Sets c.set('user', { id, email }) on success.
 */
export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'Missing or invalid Authorization header' }, 401)
  }

  const token = header.slice(7)
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${config.supabase.url}/auth/v1`,
    })

    const sub = payload.sub
    if (!sub) {
      return c.json({ ok: false, error: 'Invalid token: missing sub' }, 401)
    }

    c.set('user', { id: sub, email: payload.email as string | undefined } as AuthUser)
    await next()
  } catch (err: any) {
    return c.json({ ok: false, error: `Authentication failed: ${err.message}` }, 401)
  }
}
