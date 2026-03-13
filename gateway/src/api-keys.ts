import { createHash, randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import type { AuthUser } from './auth.js'
import { getSupabase } from './db.js'
import { log } from './log.js'

const KEY_PREFIX = 'meios_'

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** Generate a new API key for the authenticated user. */
export async function createApiKey(c: Context): Promise<Response> {
  const user = c.get('user') as AuthUser
  const body = await c.req.json().catch(() => ({}))
  const name = body.name ?? 'default'

  // Generate random key: meios_ + 32 random hex chars
  const raw = randomBytes(16).toString('hex')
  const key = KEY_PREFIX + raw
  const keyHash = hashKey(key)
  const keyPrefix = key.slice(0, 14) // "meios_" + 8 chars

  const { data, error } = await getSupabase()
    .from('api_keys')
    .insert({ user_id: user.id, key_hash: keyHash, key_prefix: keyPrefix, name })
    .select('id, key_prefix, name, created_at')
    .single()

  if (error) {
    return c.json({ ok: false, error: `Failed to create API key: ${error.message}` }, 500)
  }

  log('api-keys', 'key created', { userId: user.id, keyPrefix })

  // Return the full key only once — it cannot be retrieved again
  return c.json({ ok: true, data: { ...data, key } }, 201)
}

/** List API keys for the authenticated user (prefixes only). */
export async function listApiKeys(c: Context): Promise<Response> {
  const user = c.get('user') as AuthUser

  const { data, error } = await getSupabase()
    .from('api_keys')
    .select('id, key_prefix, name, last_used, expires_at, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) {
    return c.json({ ok: false, error: error.message }, 500)
  }

  return c.json({ ok: true, data })
}

/** Revoke (delete) an API key. */
export async function revokeApiKey(c: Context): Promise<Response> {
  const user = c.get('user') as AuthUser
  const keyId = c.req.param('id')

  const { error } = await getSupabase()
    .from('api_keys')
    .delete()
    .eq('id', keyId)
    .eq('user_id', user.id)

  if (error) {
    return c.json({ ok: false, error: error.message }, 500)
  }

  log('api-keys', 'key revoked', { userId: user.id, keyId })
  return c.json({ ok: true })
}

/** Look up a user by API key. Returns null if key is invalid or expired. */
export async function lookupByApiKey(key: string): Promise<AuthUser | null> {
  if (!key.startsWith(KEY_PREFIX)) return null

  const keyHash = hashKey(key)
  const { data, error } = await getSupabase()
    .from('api_keys')
    .select('user_id, expires_at')
    .eq('key_hash', keyHash)
    .single()

  if (error || !data) return null

  // Check expiry
  if (data.expires_at && new Date(data.expires_at) < new Date()) return null

  // Update last_used (fire-and-forget)
  getSupabase()
    .from('api_keys')
    .update({ last_used: new Date().toISOString() })
    .eq('key_hash', keyHash)
    .then(() => {})

  return { id: data.user_id }
}
