/**
 * Supabase Edge Function: LLM Proxy
 *
 * Validates sandbox token, forwards request to Anthropic API with the real key.
 * Deployed at: https://<project>.supabase.co/functions/v1/llm-proxy
 *
 * The sandbox sends requests here instead of directly to api.anthropic.com,
 * so the real ANTHROPIC_API_KEY never enters the sandbox.
 */

import { createClient } from "npm:@supabase/supabase-js@2"

const ANTHROPIC_API = "https://api.anthropic.com"
const MAX_BODY_SIZE = 524288 // 512 KB

const ALLOWED_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-5",
  "claude-opus-4-6",
]

const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'gemini-3.1-flash-lite': { inputPer1M: 25, outputPer1M: 150 },
  'kimi-k2.5': { inputPer1M: 60, outputPer1M: 300 },
  'claude-haiku-4-5-20251001': { inputPer1M: 80, outputPer1M: 400 },
  'claude-haiku-4-5': { inputPer1M: 80, outputPer1M: 400 },
  'claude-opus-4-6': { inputPer1M: 1500, outputPer1M: 7500 },
}

function calculateCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model]
  if (!pricing) return 0
  return (inputTokens * pricing.inputPer1M + outputTokens * pricing.outputPer1M) / 1_000_000
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, x-api-key, anthropic-version, anthropic-beta",
}

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

  // 2. Token extraction
  const apiKey = req.headers.get("x-api-key")
  if (!apiKey) {
    return Response.json(
      { ok: false, error: "Missing x-api-key header" },
      { status: 401, headers: CORS_HEADERS },
    )
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  const supabase = createClient(supabaseUrl, supabaseKey)

  // 3. Token hash (SHA-256) + validation with expiry check
  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(apiKey),
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

  // Budget check
  const { data: budget } = await supabase.rpc("check_budget", { p_user_id: sandbox.user_id })
  if (budget && !budget.allowed) {
    return Response.json(
      { ok: false, error: "Monthly budget exceeded", used: budget.used_cents, budget: budget.budget_cents },
      { status: 402, headers: CORS_HEADERS },
    )
  }

  // 4. Rate limit check (per-sandbox, via Supabase DB RPC)
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

  // 5. Request body size limit
  const contentLength = req.headers.get("Content-Length")
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return Response.json(
      { ok: false, error: "Request body too large" },
      { status: 413, headers: CORS_HEADERS },
    )
  }

  // --- Forward to Anthropic ---
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")
  if (!anthropicKey) {
    return Response.json(
      { ok: false, error: "LLM proxy not configured" },
      { status: 500, headers: CORS_HEADERS },
    )
  }

  // 7. Path allowlist
  const url = new URL(req.url)
  const path = url.pathname.replace(/^\/llm-proxy/, "") || "/v1/messages"

  // Only allow specific Anthropic API paths
  if (!/^\/v1\/messages(\/count_tokens|\/batches(\/.*)?)?$/.test(path)) {
    return Response.json(
      { ok: false, error: "Path not allowed" },
      { status: 403, headers: CORS_HEADERS },
    )
  }

  const targetUrl = ANTHROPIC_API + path

  const headers = new Headers()
  headers.set("x-api-key", anthropicKey)
  headers.set(
    "anthropic-version",
    req.headers.get("anthropic-version") ?? "2023-06-01",
  )
  const contentType = req.headers.get("Content-Type")
  if (contentType) headers.set("Content-Type", contentType)
  const beta = req.headers.get("anthropic-beta")
  if (beta) headers.set("anthropic-beta", beta)

  try {
    const body = await req.text()

    // Check body size when Content-Length was not provided
    if (!contentLength && body.length > MAX_BODY_SIZE) {
      return Response.json(
        { ok: false, error: "Request body too large" },
        { status: 413, headers: CORS_HEADERS },
      )
    }

    // 6. Body parse + model allowlist
    let bodyObj: any = null
    try {
      bodyObj = JSON.parse(body)
    } catch {}
    if (bodyObj?.model && !ALLOWED_MODELS.includes(bodyObj.model)) {
      return Response.json(
        { ok: false, error: `Model not allowed: ${bodyObj.model}` },
        { status: 403, headers: CORS_HEADERS },
      )
    }

    // 8. Forward to Anthropic
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: body || undefined,
    })

    const responseBody = await upstream.text()

    // Extract usage for billing (fire-and-forget)
    try {
      const parsed = JSON.parse(responseBody)
      if (parsed.usage) {
        const inputTokens = parsed.usage.input_tokens ?? 0
        const outputTokens = parsed.usage.output_tokens ?? 0
        const model = bodyObj?.model ?? "unknown"
        const costCents = calculateCostCents(model, inputTokens, outputTokens)
        supabase.rpc("record_usage", {
          p_sandbox_id: sandbox.id,
          p_user_id: sandbox.user_id,
          p_provider: "anthropic",
          p_model: model,
          p_input_tokens: inputTokens,
          p_output_tokens: outputTokens,
          p_cost_cents: costCents,
        }).then(() => {}).catch(() => {}) // fire-and-forget
      }
    } catch {} // non-JSON response — skip billing

    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
        ...CORS_HEADERS,
      },
    })
  } catch (err) {
    console.error("[llm-proxy] error:", err)
    return Response.json(
      { ok: false, error: `LLM proxy error: ${(err as Error).message}` },
      { status: 502, headers: CORS_HEADERS },
    )
  }
})
