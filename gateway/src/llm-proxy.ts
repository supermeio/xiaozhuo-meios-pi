import type { Context } from 'hono'
import { getSandboxByToken } from './db.js'
import { config } from './config.js'

const ANTHROPIC_API = 'https://api.anthropic.com'

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

  // Build target URL: same path on Anthropic API
  const path = c.req.path
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
    const body = await c.req.text()
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
    console.error('[llm-proxy] error:', err.message)
    return c.json({ ok: false, error: `LLM proxy error: ${err.message}` }, 502)
  }
}
