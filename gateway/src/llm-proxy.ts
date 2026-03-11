import type { Context } from 'hono'
import { getSandboxByToken } from './db.js'
import { config } from './config.js'
import { logError } from './log.js'
import { checkBudget, recordUsage } from './billing.js'
import { calculateCostCents } from './pricing.js'

// ── Provider configuration ──

interface ProviderConfig {
  upstream: string
  setAuth: (headers: Headers, key: string) => void
  extractUsage: (body: any) => { input: number; output: number }
  pathAllowlist: RegExp
  extractModel: (path: string, body: any) => string | null
}

const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    upstream: 'https://api.anthropic.com',
    setAuth: (h, key) => h.set('x-api-key', key),
    extractUsage: (b) => ({
      input: b?.usage?.input_tokens ?? 0,
      output: b?.usage?.output_tokens ?? 0,
    }),
    pathAllowlist: /^\/v1\/messages(\/count_tokens|\/batches(\/.*)?)?$/,
    extractModel: (_path, body) => body?.model ?? null,
  },
  google: {
    upstream: 'https://generativelanguage.googleapis.com',
    setAuth: (h, key) => h.set('x-goog-api-key', key),
    extractUsage: (b) => ({
      input: b?.usageMetadata?.promptTokenCount ?? 0,
      output:
        (b?.usageMetadata?.candidatesTokenCount ?? 0) +
        (b?.usageMetadata?.thoughtsTokenCount ?? 0),
    }),
    pathAllowlist:
      /^\/v1beta\/models\/[\w.-]+:(generateContent|streamGenerateContent|countTokens)$/,
    extractModel: (path, _body) =>
      path.match(/\/models\/([\w.-]+):/)?.[1] ?? null,
  },
  openai: {
    upstream: 'https://api.openai.com',
    setAuth: (h, key) => h.set('Authorization', `Bearer ${key}`),
    extractUsage: (b) => ({
      input: b?.usage?.prompt_tokens ?? b?.usage?.input_tokens ?? 0,
      output: b?.usage?.completion_tokens ?? b?.usage?.output_tokens ?? 0,
    }),
    pathAllowlist: /^\/v1\/(chat\/completions|responses|embeddings)$/,
    extractModel: (_path, body) => body?.model ?? null,
  },
  moonshot: {
    upstream: 'https://api.kimi.com/coding',
    setAuth: (h, key) => h.set('x-api-key', key),
    extractUsage: (b) => ({
      input: b?.usage?.input_tokens ?? 0,
      output: b?.usage?.output_tokens ?? 0,
    }),
    pathAllowlist: /^\/v1\/messages(\/count_tokens)?$/,
    extractModel: (_path, body) => body?.model ?? null,
  },
}

// ── Model allowlist per provider ──

const ALLOWED_MODELS: Record<string, string[]> = {
  anthropic: ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-opus-4-6'],
  google: [
    'gemini-3.1-flash-lite-preview',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-3-flash-preview',
    'gemini-flash-lite-latest',
  ],
  openai: ['gpt-4.1-nano', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5-nano', 'gpt-5-mini'],
  moonshot: ['kimi-k2.5', 'k2p5'],
}

// ── API key mapping ──

const PROVIDER_KEYS: Record<string, string> = {
  get anthropic() { return config.meios.anthropicKey },
  get google() { return config.meios.geminiKey },
  get openai() { return config.meios.openaiKey },
  get moonshot() { return config.meios.kimiKey },
}

// ── Constants ──

const MAX_BODY_SIZE = 524288 // 512 KB

// ── In-memory per-sandbox rate limiter ──

const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
const RATE_LIMIT_MAX = 60           // requests per window

const rateLimitMap = new Map<string, { count: number; windowStart: number }>()

// ── Token extraction ──

function extractToken(c: Context): string | null {
  // Anthropic / Kimi: x-api-key header
  const xApiKey = c.req.header('x-api-key')
  if (xApiKey) return xApiKey

  // Google: x-goog-api-key header
  const googKey = c.req.header('x-goog-api-key')
  if (googKey) return googKey

  // Google: query param ?key=
  const url = new URL(c.req.url)
  const queryKey = url.searchParams.get('key')
  if (queryKey) return queryKey

  // OpenAI: Bearer token
  const auth = c.req.header('Authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7)

  return null
}

// ── Provider detection ──

function detectProvider(
  path: string,
): { provider: string; upstreamPath: string } | null {
  if (path.startsWith('/google/'))
    return { provider: 'google', upstreamPath: path.slice('/google'.length) }
  if (path.startsWith('/openai/'))
    return { provider: 'openai', upstreamPath: path.slice('/openai'.length) }
  if (path.startsWith('/moonshot/'))
    return { provider: 'moonshot', upstreamPath: path.slice('/moonshot'.length) }
  if (/^\/v1\/messages/.test(path))
    return { provider: 'anthropic', upstreamPath: path }
  return null
}

// ── Main handler ──

/**
 * Proxy LLM requests from sandboxes to upstream providers.
 *
 * Sandboxes send requests with their sandbox token. This handler validates
 * the token, enforces rate limits and budget, then forwards the request
 * to the appropriate upstream provider with the real API key.
 *
 * Routes:
 *   /v1/messages/*   → Anthropic
 *   /google/*        → Google Generative AI
 *   /openai/*        → OpenAI
 *   /moonshot/*      → Moonshot (Anthropic-compatible)
 */
export async function llmProxy(c: Context): Promise<Response> {
  // Detect provider from path
  const path = c.req.path
  const detected = detectProvider(path)
  if (!detected) {
    return c.json({ ok: false, error: 'Unknown provider route' }, 404)
  }
  const { provider, upstreamPath } = detected
  const providerConfig = PROVIDERS[provider]

  // Auth: extract sandbox token
  const token = extractToken(c)
  if (!token) {
    return c.json({ ok: false, error: 'Missing authentication' }, 401)
  }

  const sandbox = await getSandboxByToken(token)
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
    const retryAfter = Math.ceil(
      (entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000,
    )
    return c.json({ ok: false, error: 'Rate limit exceeded' }, 429, {
      'Retry-After': String(retryAfter),
    } as any)
  }

  // Budget check
  const budget = await checkBudget(sandbox.user_id)
  if (!budget.allowed) {
    return c.json(
      {
        ok: false,
        error: 'Monthly budget exceeded',
        used: budget.used_cents,
        budget: budget.budget_cents,
      },
      402,
    )
  }

  // Request body size limit (Content-Length pre-check)
  const contentLength = c.req.header('Content-Length')
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return c.json({ ok: false, error: 'Request body too large' }, 413)
  }

  try {
    // Read body with streaming size limit
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
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    const body = new TextDecoder().decode(merged)

    // Parse body and check model allowlist
    let bodyObj: any = null
    try {
      bodyObj = JSON.parse(body)
    } catch {}

    const model = providerConfig.extractModel(upstreamPath, bodyObj)
    const allowedModels = ALLOWED_MODELS[provider]
    if (model && allowedModels && !allowedModels.includes(model)) {
      return c.json({ ok: false, error: `Model not allowed: ${model}` }, 403)
    }

    // Path allowlist per provider
    if (!providerConfig.pathAllowlist.test(upstreamPath)) {
      return c.json({ ok: false, error: 'Path not allowed' }, 403)
    }

    // Build upstream URL
    const targetUrl = providerConfig.upstream + upstreamPath

    // Build headers with provider-specific auth
    const headers = new Headers()
    const realKey = PROVIDER_KEYS[provider]
    providerConfig.setAuth(headers, realKey)

    const contentType = c.req.header('Content-Type')
    if (contentType) {
      headers.set('Content-Type', contentType)
    }

    // Forward provider-specific headers
    if (provider === 'anthropic' || provider === 'moonshot') {
      headers.set(
        'anthropic-version',
        c.req.header('anthropic-version') ?? '2023-06-01',
      )
      const beta = c.req.header('anthropic-beta')
      if (beta) {
        headers.set('anthropic-beta', beta)
      }
    }

    // Forward request to upstream
    const upstream = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: body || undefined,
    })

    const responseBody = await upstream.text()

    // Extract usage for billing (fire-and-forget)
    try {
      const parsed = JSON.parse(responseBody)
      const usage = providerConfig.extractUsage(parsed)
      if (usage.input > 0 || usage.output > 0) {
        const modelName = model ?? 'unknown'
        const costCents = calculateCostCents(modelName, usage.input, usage.output)
        recordUsage({
          sandboxId: sandbox.id,
          userId: sandbox.user_id,
          provider,
          model: modelName,
          inputTokens: usage.input,
          outputTokens: usage.output,
          costCents,
        }).catch(() => {}) // fire-and-forget
      }
    } catch {} // non-JSON response (e.g., streaming) — skip billing for now

    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        'Content-Type':
          upstream.headers.get('Content-Type') ?? 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (err: any) {
    logError('llm-proxy', 'upstream request failed', err)
    return c.json(
      { ok: false, error: `LLM proxy error: ${err.message}` },
      502,
    )
  }
}
