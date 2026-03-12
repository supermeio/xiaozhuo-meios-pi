import type { Context } from 'hono'
import { config } from './config.js'
import { logError } from './log.js'

/**
 * Thin relay to LiteLLM proxy.
 *
 * LiteLLM handles: virtual key auth, rate limiting, budget enforcement,
 * provider routing, usage tracking, and cost calculation.
 *
 * This handler just forwards the request with the virtual key intact.
 *
 * Routes:
 *   /v1/messages*   → LiteLLM /anthropic/v1/messages* (Anthropic pass-through)
 *   /chat/completions → LiteLLM /chat/completions (OpenAI format)
 *   /v1/chat/completions → LiteLLM /v1/chat/completions
 *   /openai/*       → LiteLLM /openai/* (OpenAI pass-through)
 *   /google/*       → LiteLLM /chat/completions (rewritten — no native Gemini pass-through)
 *   /moonshot/*     → LiteLLM /chat/completions (rewritten)
 */

const LITELLM_URL = config.litellm.proxyUrl

/**
 * Extract auth token from request (any format the sandbox might use).
 */
function extractToken(c: Context): string | null {
  const xApiKey = c.req.header('x-api-key')
  if (xApiKey) return xApiKey

  const googKey = c.req.header('x-goog-api-key')
  if (googKey) return googKey

  const url = new URL(c.req.url)
  const queryKey = url.searchParams.get('key')
  if (queryKey) return queryKey

  const auth = c.req.header('Authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7)

  return null
}

/**
 * Map incoming path to LiteLLM target path.
 */
function mapPath(path: string): string {
  // Anthropic native → LiteLLM Anthropic pass-through
  if (path.startsWith('/v1/messages')) return '/anthropic' + path
  // OpenAI native paths → forward as-is
  if (path.startsWith('/chat/completions')) return path
  if (path.startsWith('/v1/chat/completions')) return path
  // Legacy provider-prefixed paths (kept for backwards compat)
  if (path.startsWith('/openai/')) return path
  // Default: forward as-is (LiteLLM will handle)
  return path
}

export async function llmProxy(c: Context): Promise<Response> {
  const token = extractToken(c)
  if (!token) {
    return c.json({ ok: false, error: 'Missing authentication' }, 401)
  }

  const path = c.req.path
  const targetPath = mapPath(path)
  const targetUrl = LITELLM_URL + targetPath

  try {
    // Build headers: use Bearer auth for LiteLLM virtual key
    const headers = new Headers()
    headers.set('Authorization', `Bearer ${token}`)

    const contentType = c.req.header('Content-Type')
    if (contentType) headers.set('Content-Type', contentType)

    // Forward Anthropic-specific headers for pass-through
    const anthropicVersion = c.req.header('anthropic-version')
    if (anthropicVersion) headers.set('anthropic-version', anthropicVersion)
    const anthropicBeta = c.req.header('anthropic-beta')
    if (anthropicBeta) headers.set('anthropic-beta', anthropicBeta)

    const upstream = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
    })

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (err: any) {
    logError('llm-proxy', 'relay to LiteLLM failed', err)
    return c.json({ ok: false, error: `LLM proxy error: ${err.message}` }, 502)
  }
}
