import type { Context } from 'hono'
import { getSandboxByToken } from './db.js'
import { config } from './config.js'
import { logError } from './log.js'

const ANTHROPIC_API = 'https://api.anthropic.com'
const MAX_BODY_SIZE = 524288 // 512 KB
const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-sonnet-4-5-20250514', 'claude-sonnet-4-5']

// ── In-memory per-sandbox rate limiter ──

const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
const RATE_LIMIT_MAX = 60           // requests per window

const rateLimitMap = new Map<string, { count: number; windowStart: number }>()

/**
 * Proxy LLM requests from sandboxes to the Anthropic API.
 *
 * Sandboxes send requests with their sandbox token as x-api-key.
 * This handler validates the token, then forwards to Anthropic
 * with the real ANTHROPIC_API_KEY. The real key never enters any sandbox.
 *
 * Handles: POST /v1/messages, POST /v1/messages/count_tokens, etc.
 */
export async function llmProxy(c: Context): Promise<Response> {
  // Auth: sandbox token via x-api-key header (same as Anthropic SDK sends)
  const apiKey = c.req.header('x-api-key')
  if (!apiKey) {
    return c.json({ ok: false, error: 'Missing x-api-key header' }, 401)
  }

  const sandbox = await getSandboxByToken(apiKey)
  if (!sandbox) {
    return c.json({ ok: false, error: 'Invalid sandbox token' }, 401)
  }

  // Rate limiting: 60 requests per minute per sandbox
  const now = Date.now()
  const sandboxId = sandbox.id
  let entry = rateLimitMap.get(sandboxId)
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now }
    rateLimitMap.set(sandboxId, entry)
  }
  entry.count++
  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000)
    return c.json({ ok: false, error: 'Rate limit exceeded' }, 429, {
      'Retry-After': String(retryAfter),
    } as any)
  }

  // Request body size limit
  const contentLength = c.req.header('Content-Length')
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return c.json({ ok: false, error: 'Request body too large' }, 413)
  }

  // Path allowlist: only specific Anthropic API paths
  const path = c.req.path
  if (!/^\/v1\/messages(\/count_tokens|\/batches(\/.*)?)?$/.test(path)) {
    return c.json({ ok: false, error: 'Path not allowed' }, 403)
  }
  const targetUrl = ANTHROPIC_API + path

  // Forward request to Anthropic with the real API key
  const headers = new Headers()
  headers.set('x-api-key', config.meios.anthropicKey)
  headers.set('anthropic-version', c.req.header('anthropic-version') ?? '2023-06-01')

  const contentType = c.req.header('Content-Type')
  if (contentType) {
    headers.set('Content-Type', contentType)
  }

  // Forward anthropic-beta header if present (for extended thinking, etc.)
  const beta = c.req.header('anthropic-beta')
  if (beta) {
    headers.set('anthropic-beta', beta)
  }

  try {
    // Read body with streaming size limit (defends against chunked requests without Content-Length)
    const reader = c.req.raw.body?.getReader()
    if (!reader) {
      return c.json({ ok: false, error: 'Missing request body' }, 400)
    }
    const chunks: Uint8Array[] = []
    let totalSize = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalSize += value.length
      if (totalSize > MAX_BODY_SIZE) {
        reader.cancel()
        return c.json({ ok: false, error: 'Request body too large' }, 413)
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(totalSize)
    let offset = 0
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length }
    const body = new TextDecoder().decode(merged)

    // Model allowlist
    let bodyObj: any = null
    try { bodyObj = JSON.parse(body) } catch {}
    if (bodyObj?.model && !ALLOWED_MODELS.includes(bodyObj.model)) {
      return c.json({ ok: false, error: `Model not allowed: ${bodyObj.model}` }, 403)
    }

    const upstream = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: body || undefined,
    })

    // Stream through the response as-is
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (err: any) {
    logError('llm-proxy', 'upstream request failed', err)
    return c.json({ ok: false, error: `LLM proxy error: ${err.message}` }, 502)
  }
}
