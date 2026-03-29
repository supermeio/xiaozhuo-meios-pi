/**
 * Credential injection proxy — sandbox calls external APIs through the gateway.
 *
 * Per-user credentials stored encrypted in Supabase PG. The gateway decrypts
 * them in memory, mints service-specific tokens, and injects into requests.
 * Falls back to platform-level credentials if user has none configured.
 *
 * MVP: supports Google APIs only (Docs, Drive, Sheets).
 */

import type { Context } from 'hono'
import { SignJWT, importPKCS8 } from 'jose'
import { config } from './config.js'
import { getCredential } from './db.js'
import { decrypt } from './crypto.js'
import { logger } from './log.js'

const log = logger.getSubLogger({ name: 'credential-proxy' })

// ── Allowlist ──

const ALLOWED_HOSTS = new Set([
  'docs.googleapis.com',
  'sheets.googleapis.com',
  'www.googleapis.com',
  'content-docs.googleapis.com',
])

// ── Google SA Config ──

interface GoogleSAConfig {
  clientEmail: string
  privateKey: string
  impersonateUser?: string
}

// ── Per-user Token Cache ──

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
].join(' ')

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const REFRESH_MARGIN_MS = 5 * 60 * 1000
const MAX_CACHE_SIZE = 256

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>()

function evictExpired() {
  const now = Date.now()
  for (const [key, val] of tokenCache) {
    if (now > val.expiresAt) tokenCache.delete(key)
  }
}

async function getGoogleAccessToken(cacheKey: string, sa: GoogleSAConfig): Promise<string> {
  const cached = tokenCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt - REFRESH_MARGIN_MS) {
    return cached.accessToken
  }

  const privateKey = await importPKCS8(sa.privateKey, 'RS256')
  const now = Math.floor(Date.now() / 1000)

  const claims: Record<string, unknown> = {
    iss: sa.clientEmail,
    scope: GOOGLE_SCOPES,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  }
  if (sa.impersonateUser) {
    claims.sub = sa.impersonateUser
  }

  const jwt = await new SignJWT(claims as any)
    .setProtectedHeader({ alg: 'RS256' })
    .sign(privateKey)

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google token exchange failed (${res.status}): ${text.slice(0, 200)}`)
  }

  const data = await res.json() as { access_token: string; expires_in: number }
  const entry = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }

  // Evict if cache is full
  if (tokenCache.size >= MAX_CACHE_SIZE) evictExpired()
  if (tokenCache.size >= MAX_CACHE_SIZE) {
    // Still full after eviction — delete oldest
    const oldest = tokenCache.keys().next().value
    if (oldest) tokenCache.delete(oldest)
  }

  tokenCache.set(cacheKey, entry)
  return entry.accessToken
}

// ── Resolve credentials for a user ──

async function resolveGoogleSA(userId: string): Promise<{ sa: GoogleSAConfig; cacheKey: string } | null> {
  // 1. Try user-specific credential from Supabase
  if (config.credentialEncryptionKey) {
    const cred = await getCredential(userId, 'google')
    if (cred) {
      try {
        // Supabase returns bytea as \x-prefixed hex strings
        const encData = cred.encrypted_data.startsWith('\\x')
          ? Buffer.from(cred.encrypted_data.slice(2), 'hex')
          : Buffer.from(cred.encrypted_data, 'base64')
        const ivData = cred.iv.startsWith('\\x')
          ? Buffer.from(cred.iv.slice(2), 'hex')
          : Buffer.from(cred.iv, 'base64')
        const plaintext = decrypt(encData, ivData, config.credentialEncryptionKey)
        const sa = JSON.parse(plaintext)
        return {
          sa: {
            clientEmail: sa.client_email,
            privateKey: sa.private_key,
            impersonateUser: sa.impersonate_user,
          },
          cacheKey: `${userId}:google`,
        }
      } catch (err: any) {
        log.error('failed to decrypt credential', { userId, error: err.message })
      }
    }
  }

  // No fallback — each user must configure their own credentials.
  // Platform-level SA (config.google) is for internal/admin use only.
  return null
}

// ── Route Handler ──

interface ProxyRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

/**
 * POST /internal/v1/proxy
 *
 * Sandbox sends a request description; gateway resolves per-user credentials,
 * injects them, and forwards to the external API.
 */
export async function credentialProxy(c: Context) {
  const userId = c.get('sandboxUserId') as string

  let req: ProxyRequest
  try {
    req = await c.req.json<ProxyRequest>()
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400)
  }

  const { url, method = 'GET', headers = {}, body } = req

  if (!url || typeof url !== 'string') {
    return c.json({ ok: false, error: 'Missing or invalid url' }, 400)
  }

  // Validate target host
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return c.json({ ok: false, error: 'Invalid url' }, 400)
  }

  if (!ALLOWED_HOSTS.has(parsedUrl.hostname)) {
    return c.json({ ok: false, error: `Host not allowed: ${parsedUrl.hostname}` }, 403)
  }

  // Resolve credentials (per-user → platform fallback)
  const resolved = await resolveGoogleSA(userId)
  if (!resolved) {
    return c.json({ ok: false, error: 'No Google credentials configured for this user' }, 503)
  }

  // Get access token (cached per user)
  let accessToken: string
  try {
    accessToken = await getGoogleAccessToken(resolved.cacheKey, resolved.sa)
  } catch (err: any) {
    log.error('token error', { error: err.message })
    return c.json({ ok: false, error: 'Failed to obtain credentials' }, 502)
  }

  // Build outgoing headers
  const outHeaders: Record<string, string> = { ...headers }
  outHeaders['Authorization'] = `Bearer ${accessToken}`
  if (body && !outHeaders['Content-Type']) {
    outHeaders['Content-Type'] = 'application/json'
  }

  // Forward request
  try {
    const upstream = await fetch(url, {
      method,
      headers: outHeaders,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })

    const contentType = upstream.headers.get('content-type') ?? ''
    let responseBody: unknown
    if (contentType.includes('application/json')) {
      responseBody = await upstream.json()
    } else {
      responseBody = await upstream.text()
    }

    const responseHeaders: Record<string, string> = {}
    for (const key of ['content-type', 'x-request-id']) {
      const val = upstream.headers.get(key)
      if (val) responseHeaders[key] = val
    }

    return c.json({
      ok: true,
      data: { status: upstream.status, headers: responseHeaders, body: responseBody },
    })
  } catch (err: any) {
    log.error('upstream error', { error: err.message })
    return c.json({ ok: false, error: `Upstream request failed: ${err.message}` }, 502)
  }
}
