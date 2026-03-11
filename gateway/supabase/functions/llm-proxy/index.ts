/**
 * Supabase Edge Function: LLM Proxy (Multi-Provider)
 *
 * Validates sandbox token, checks rate limits & budget, then forwards
 * to the appropriate upstream LLM provider.
 *
 * Provider routing by path prefix:
 *   /v1/messages*        → Anthropic (default, no prefix)
 *   /google/*            → Google Gemini
 *   /openai/*            → OpenAI
 *   /moonshot/*          → Moonshot (Kimi)
 *
 * Deployed at: https://<project>.supabase.co/functions/v1/llm-proxy
 */

import { createClient } from "npm:@supabase/supabase-js@2"

/* ───────────────────────── Provider configuration ───────────────────────── */

interface ProviderConfig {
  upstream: string
  envKey: string
  setAuth: (headers: Headers, key: string) => void
  extractUsage: (body: any) => { input: number; output: number }
  pathAllowlist: RegExp
  extractModel: (path: string, body: any) => string | null
}

const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    upstream: 'https://api.anthropic.com',
    envKey: 'ANTHROPIC_API_KEY',
    setAuth: (h, key) => { h.set('x-api-key', key) },
    extractUsage: (b) => ({
      input: b?.usage?.input_tokens ?? 0,
      output: b?.usage?.output_tokens ?? 0,
    }),
    pathAllowlist: /^\/v1\/messages(\/count_tokens|\/batches(\/.*)?)?$/,
    extractModel: (_p, body) => body?.model ?? null,
  },
  google: {
    upstream: 'https://generativelanguage.googleapis.com',
    envKey: 'GOOGLE_API_KEY',
    setAuth: (h, key) => { h.set('x-goog-api-key', key) },
    extractUsage: (b) => ({
      input: b?.usageMetadata?.promptTokenCount ?? 0,
      output: (b?.usageMetadata?.candidatesTokenCount ?? 0) +
              (b?.usageMetadata?.thoughtsTokenCount ?? 0),
    }),
    pathAllowlist: /^\/v1beta\/models\/[\w.-]+:(generateContent|streamGenerateContent|countTokens)$/,
    extractModel: (path) => path.match(/\/models\/([\w.-]+):/)?.[1] ?? null,
  },
  openai: {
    upstream: 'https://api.openai.com',
    envKey: 'OPENAI_API_KEY',
    setAuth: (h, key) => { h.set('Authorization', `Bearer ${key}`) },
    extractUsage: (b) => ({
      input: b?.usage?.prompt_tokens ?? b?.usage?.input_tokens ?? 0,
      output: b?.usage?.completion_tokens ?? b?.usage?.output_tokens ?? 0,
    }),
    pathAllowlist: /^\/v1\/(chat\/completions|responses|embeddings)$/,
    extractModel: (_p, body) => body?.model ?? null,
  },
  moonshot: {
    upstream: 'https://api.kimi.com/coding',
    envKey: 'KIMI_API_KEY',
    setAuth: (h, key) => { h.set('x-api-key', key) },
    extractUsage: (b) => ({
      input: b?.usage?.input_tokens ?? 0,
      output: b?.usage?.output_tokens ?? 0,
    }),
    pathAllowlist: /^\/v1\/messages(\/count_tokens)?$/,
    extractModel: (_p, body) => body?.model ?? null,
  },
}

/* ─────────────────────── Model allowlist per provider ────────────────────── */

const ALLOWED_MODELS: Record<string, string[]> = {
  anthropic: ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-opus-4-6'],
  google: [
    'gemini-3.1-flash-lite-preview', 'gemini-2.5-flash-lite', 'gemini-2.5-flash',
    'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-flash-lite-latest',
  ],
  openai: ['gpt-4.1-nano', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5-nano', 'gpt-5-mini'],
  moonshot: ['kimi-k2.5', 'k2p5'],
}

/* ──────────────────────────── Pricing table ──────────────────────────────── */

const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'gemini-3.1-flash-lite-preview': { inputPer1M: 25, outputPer1M: 150 },
  'gemini-2.5-flash-lite': { inputPer1M: 25, outputPer1M: 150 },
  'gemini-2.5-flash': { inputPer1M: 150, outputPer1M: 600 },
  'gemini-2.5-pro': { inputPer1M: 125, outputPer1M: 1000 },
  'gemini-3-flash-preview': { inputPer1M: 150, outputPer1M: 600 },
  'gemini-flash-lite-latest': { inputPer1M: 25, outputPer1M: 150 },
  'kimi-k2.5': { inputPer1M: 60, outputPer1M: 300 },
  'k2p5': { inputPer1M: 60, outputPer1M: 300 },
  'claude-haiku-4-5-20251001': { inputPer1M: 80, outputPer1M: 400 },
  'claude-haiku-4-5': { inputPer1M: 80, outputPer1M: 400 },
  'claude-opus-4-6': { inputPer1M: 1500, outputPer1M: 7500 },
  'gpt-4.1-nano': { inputPer1M: 10, outputPer1M: 40 },
  'gpt-4.1-mini': { inputPer1M: 40, outputPer1M: 160 },
  'gpt-4.1': { inputPer1M: 200, outputPer1M: 800 },
  'gpt-5-nano': { inputPer1M: 10, outputPer1M: 40 },
  'gpt-5-mini': { inputPer1M: 40, outputPer1M: 160 },
}

function calculateCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model]
  if (!pricing) return 0
  return (inputTokens * pricing.inputPer1M + outputTokens * pricing.outputPer1M) / 1_000_000
}

/* ──────────────────────────── Provider detection ─────────────────────────── */

function detectProvider(path: string): { provider: string; upstreamPath: string } | null {
  if (path.startsWith('/google/')) return { provider: 'google', upstreamPath: path.slice('/google'.length) }
  if (path.startsWith('/openai/')) return { provider: 'openai', upstreamPath: path.slice('/openai'.length) }
  if (path.startsWith('/moonshot/')) return { provider: 'moonshot', upstreamPath: path.slice('/moonshot'.length) }
  if (/^\/v1\/messages/.test(path)) return { provider: 'anthropic', upstreamPath: path }
  return null
}

/* ──────────────────────── Token extraction (unified) ─────────────────────── */

function extractToken(req: Request): string | null {
  const xApiKey = req.headers.get('x-api-key')
  if (xApiKey) return xApiKey

  const googKey = req.headers.get('x-goog-api-key')
  if (googKey) return googKey

  const authHeader = req.headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)

  const url = new URL(req.url)
  const queryKey = url.searchParams.get('key')
  if (queryKey) return queryKey

  return null
}

/* ─────────────────────────────── Constants ───────────────────────────────── */

const MAX_BODY_SIZE = 524288 // 512 KB

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-api-key, x-goog-api-key, anthropic-version, anthropic-beta",
}

/* ──────────────────────────────── Handler ────────────────────────────────── */

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  // 1. Method check
  if (req.method !== "POST") {
    return Response.json(
      { ok: false, error: "Method not allowed" },
      { status: 405, headers: CORS_HEADERS },
    )
  }

  // 2. Token extraction (unified: x-api-key → x-goog-api-key → Bearer → ?key=)
  const sandboxToken = extractToken(req)
  if (!sandboxToken) {
    return Response.json(
      { ok: false, error: "Missing authentication token" },
      { status: 401, headers: CORS_HEADERS },
    )
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  const supabase = createClient(supabaseUrl, supabaseKey)

  // 3. Token hash (SHA-256) + validation with expiry check
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(sandboxToken),
  )
  const hashedToken = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

  const { data: sandbox, error: dbError } = await supabase
    .from("sandboxes")
    .select("id, user_id")
    .eq("token", hashedToken)
    .eq("status", "active")
    .or(
      `token_expires_at.gt.${new Date().toISOString()},token_expires_at.is.null`,
    )
    .single()

  if (dbError || !sandbox) {
    return Response.json(
      { ok: false, error: "Invalid sandbox token" },
      { status: 401, headers: CORS_HEADERS },
    )
  }

  // 4. Budget check
  const { data: budget } = await supabase.rpc("check_budget", { p_user_id: sandbox.user_id })
  if (budget && !budget.allowed) {
    return Response.json(
      { ok: false, error: "Monthly budget exceeded", used: budget.used_cents, budget: budget.budget_cents },
      { status: 402, headers: CORS_HEADERS },
    )
  }

  // 5. Rate limit check (per-sandbox)
  const { data: rl } = await supabase.rpc("check_rate_limit", {
    p_sandbox_id: sandbox.id,
    p_minute_limit: 60,
    p_daily_limit: 1000,
  })
  if (!rl?.allowed) {
    return Response.json(
      { ok: false, error: "Rate limit exceeded" },
      { status: 429, headers: CORS_HEADERS },
    )
  }

  // 6. Body size limit (Content-Length header)
  const contentLength = req.headers.get("Content-Length")
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return Response.json(
      { ok: false, error: "Request body too large" },
      { status: 413, headers: CORS_HEADERS },
    )
  }

  // 7. Provider detection
  const url = new URL(req.url)
  const path = url.pathname.replace(/^.*\/llm-proxy/, "") || "/v1/messages"

  const route = detectProvider(path)
  if (!route) {
    return Response.json(
      { ok: false, error: "Unknown provider or path" },
      { status: 404, headers: CORS_HEADERS },
    )
  }

  const { provider, upstreamPath } = route
  const config = PROVIDERS[provider]

  // 8. Path allowlist
  if (!config.pathAllowlist.test(upstreamPath)) {
    return Response.json(
      { ok: false, error: "Path not allowed" },
      { status: 403, headers: CORS_HEADERS },
    )
  }

  // 9. Provider API key
  const providerKey = Deno.env.get(config.envKey)
  if (!providerKey) {
    return Response.json(
      { ok: false, error: `LLM proxy not configured for ${provider}` },
      { status: 500, headers: CORS_HEADERS },
    )
  }

  try {
    const body = await req.text()

    // Body size limit (when Content-Length was absent)
    if (!contentLength && body.length > MAX_BODY_SIZE) {
      return Response.json(
        { ok: false, error: "Request body too large" },
        { status: 413, headers: CORS_HEADERS },
      )
    }

    // 10. Body parse + model allowlist
    let bodyObj: any = null
    try { bodyObj = JSON.parse(body) } catch { /* non-JSON is fine for some endpoints */ }

    const model = config.extractModel(upstreamPath, bodyObj)
    const allowlist = ALLOWED_MODELS[provider] ?? []
    if (model && !allowlist.includes(model)) {
      return Response.json(
        { ok: false, error: `Model not allowed: ${model}` },
        { status: 403, headers: CORS_HEADERS },
      )
    }

    // 11. Build upstream request headers
    const headers = new Headers()
    config.setAuth(headers, providerKey)

    const contentType = req.headers.get("Content-Type")
    if (contentType) headers.set("Content-Type", contentType)

    // Provider-specific headers
    if (provider === 'anthropic' || provider === 'moonshot') {
      headers.set("anthropic-version", req.headers.get("anthropic-version") ?? "2023-06-01")
      const beta = req.headers.get("anthropic-beta")
      if (beta) headers.set("anthropic-beta", beta)
    }

    // 12. Forward to upstream provider
    const targetUrl = config.upstream + upstreamPath
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: body || undefined,
    })

    const contentType = upstream.headers.get("Content-Type") ?? "application/json"
    const isStreaming = contentType.includes("text/event-stream") ||
                        contentType.includes("application/x-ndjson") ||
                        url.searchParams.get("alt") === "sse"

    if (isStreaming && upstream.body) {
      // 13a. Stream response through — tee the stream for billing
      const [clientStream, billingStream] = upstream.body.tee()

      // Extract usage from the streamed response in background
      ;(async () => {
        try {
          const text = await new Response(billingStream).text()
          // SSE format: lines starting with "data: " contain JSON
          const chunks = text.split("\n")
            .filter(l => l.startsWith("data: "))
            .map(l => { try { return JSON.parse(l.slice(6)) } catch { return null } })
            .filter(Boolean)
          // Usage is typically in the last chunk
          const lastChunk = chunks[chunks.length - 1]
          if (lastChunk) {
            const usage = config.extractUsage(lastChunk)
            if (usage.input > 0 || usage.output > 0) {
              const modelName = model ?? "unknown"
              const costCents = calculateCostCents(modelName, usage.input, usage.output)
              await supabase.rpc("record_usage", {
                p_sandbox_id: sandbox.id,
                p_user_id: sandbox.user_id,
                p_provider: provider,
                p_model: modelName,
                p_input_tokens: usage.input,
                p_output_tokens: usage.output,
                p_cost_cents: costCents,
              })
            }
          }
        } catch { /* billing error — don't block response */ }
      })()

      return new Response(clientStream, {
        status: upstream.status,
        headers: { "Content-Type": contentType, ...CORS_HEADERS },
      })
    }

    // 13b. Non-streaming: buffer and extract usage
    const responseBody = await upstream.text()
    try {
      const parsed = JSON.parse(responseBody)
      const usage = config.extractUsage(parsed)
      if (usage.input > 0 || usage.output > 0) {
        const modelName = model ?? "unknown"
        const costCents = calculateCostCents(modelName, usage.input, usage.output)
        supabase.rpc("record_usage", {
          p_sandbox_id: sandbox.id,
          p_user_id: sandbox.user_id,
          p_provider: provider,
          p_model: modelName,
          p_input_tokens: usage.input,
          p_output_tokens: usage.output,
          p_cost_cents: costCents,
        }).then(() => {}).catch(() => {}) // fire-and-forget
      }
    } catch { /* non-JSON response — skip billing */ }

    return new Response(responseBody, {
      status: upstream.status,
      headers: { "Content-Type": contentType, ...CORS_HEADERS },
    })
  } catch (err) {
    console.error(`[llm-proxy] ${provider} error:`, err)
    return Response.json(
      { ok: false, error: `LLM proxy error: ${(err as Error).message}` },
      { status: 502, headers: CORS_HEADERS },
    )
  }
})
