/**
 * User credential management API.
 *
 * Users store encrypted credentials via the gateway. The gateway holds the
 * encryption key; Supabase PG only sees ciphertext. Credentials are used
 * by the credential injection proxy to call external APIs on behalf of users.
 */

import type { Context } from 'hono'
import type { AuthUser } from './auth.js'
import { config } from './config.js'
import { encrypt } from './crypto.js'
import {
  upsertCredential as dbUpsert,
  listCredentials as dbList,
  deleteCredential as dbDelete,
} from './db.js'
import { log } from './log.js'

/**
 * PUT /api/v1/credentials/:service
 * Body: { credential: <json object>, label?: string }
 *
 * Encrypts the credential immediately; plaintext is never stored or logged.
 */
export async function putCredential(c: Context): Promise<Response> {
  if (!config.credentialEncryptionKey) {
    return c.json({ ok: false, error: 'Credential storage not configured' }, 503)
  }

  const user = c.get('user') as AuthUser
  const service = c.req.param('service')!

  if (!/^[a-z0-9-]+$/.test(service)) {
    return c.json({ ok: false, error: 'Invalid service name' }, 400)
  }

  const body = await c.req.json().catch(() => null)
  if (!body?.credential || typeof body.credential !== 'object') {
    return c.json({ ok: false, error: 'credential (JSON object) is required' }, 400)
  }

  const plaintext = JSON.stringify(body.credential)
  const { ciphertext, iv } = encrypt(plaintext, config.credentialEncryptionKey)
  const label = body.label ?? service

  try {
    const result = await dbUpsert(user.id, service, ciphertext, iv, label)
    log('credentials', 'stored', { userId: user.id, service })
    return c.json({
      ok: true,
      data: { service: result.service, label: result.label, created_at: result.created_at },
    })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500)
  }
}

/**
 * GET /api/v1/credentials
 * Returns metadata only — never returns encrypted data.
 */
export async function getCredentials(c: Context): Promise<Response> {
  const user = c.get('user') as AuthUser

  try {
    const credentials = await dbList(user.id)
    return c.json({ ok: true, data: { credentials } })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500)
  }
}

/**
 * DELETE /api/v1/credentials/:service
 */
export async function removeCredential(c: Context): Promise<Response> {
  const user = c.get('user') as AuthUser
  const service = c.req.param('service')!

  try {
    await dbDelete(user.id, service)
    log('credentials', 'deleted', { userId: user.id, service })
    return c.json({ ok: true })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500)
  }
}
