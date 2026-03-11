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
  "claude-sonnet-4-5-20250514",
  "claude-sonnet-4-5",
]

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
    .select("id")
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

    // Stream the response back
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("Content-Type") ?? "application/json",
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
