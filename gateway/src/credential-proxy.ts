/**
 * Credential injection proxy — sandbox calls external APIs through the gateway.
 *
 * The sandbox never holds real credentials. Instead, it sends requests to this
 * proxy endpoint, and the gateway injects credentials before forwarding.
 *
 * MVP: supports Google APIs only (Docs, Drive, Sheets).
 * Uses jose (already a dependency) to mint Google SA OAuth2 tokens.
 */

import type { Context } from 'hono'
import { SignJWT, importPKCS8 } from 'jose'
import { config } from './config.js'

// ── Allowlist ──

const ALLOWED_HOSTS = new Set([
  'docs.googleapis.com',
  'sheets.googleapis.com',
  'www.googleapis.com',
  'content-docs.googleapis.com',
])

// ── Google SA Token Manager ──

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
].join(' ')

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const REFRESH_MARGIN_MS = 5 * 60 * 1000 // refresh 5 min before expiry

let _cachedToken: { accessToken: string; expiresAt: number } | null = null

async function getGoogleAccessToken(): Promise<string> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - REFRESH_MARGIN_MS) {
    return _cachedToken.accessToken
  }

  const google = config.google
  if (!google) throw new Error('Google SA not configured')

  const privateKey = await importPKCS8(google.privateKey, 'RS256')
  const now = Math.floor(Date.now() / 1000)

  // Build JWT claims for domain-wide delegation (impersonation)
  const claims: Record<string, unknown> = {
    iss: google.clientEmail,
    scope: GOOGLE_SCOPES,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  }
  if (google.impersonateUser) {
    claims.sub = google.impersonateUser
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
  _cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }

  return _cachedToken.accessToken
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
 * Sandbox sends a request description; gateway injects credentials and forwards.
 *
 * Body: { url, method?, headers?, body? }
 * Returns: { ok, data: { status, headers, body } }
 */
export async function credentialProxy(c: Context) {
  if (!config.google) {
    return c.json({ ok: false, error: 'Credential proxy not configured (no Google SA)' }, 503)
  }

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

  // Get Google access token and inject
  let accessToken: string
  try {
    accessToken = await getGoogleAccessToken()
  } catch (err: any) {
    console.error('[credential-proxy] token error:', err.message)
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

    // Parse response
    const contentType = upstream.headers.get('content-type') ?? ''
    let responseBody: unknown
    if (contentType.includes('application/json')) {
      responseBody = await upstream.json()
    } else {
      responseBody = await upstream.text()
    }

    // Extract a few safe response headers
    const responseHeaders: Record<string, string> = {}
    for (const key of ['content-type', 'x-request-id']) {
      const val = upstream.headers.get(key)
      if (val) responseHeaders[key] = val
    }

    return c.json({
      ok: true,
      data: {
        status: upstream.status,
        headers: responseHeaders,
        body: responseBody,
      },
    })
  } catch (err: any) {
    console.error('[credential-proxy] upstream error:', err.message)
    return c.json({ ok: false, error: `Upstream request failed: ${err.message}` }, 502)
  }
}
