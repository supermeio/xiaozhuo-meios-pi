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

  if (req.method !== "POST") {
    return Response.json(
      { ok: false, error: "Method not allowed" },
      { status: 405, headers: CORS_HEADERS },
    )
  }

  // --- Auth: validate sandbox token ---
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

  const { data: sandbox, error: dbError } = await supabase
    .from("sandboxes")
    .select("id")
    .eq("token", apiKey)
    .eq("status", "active")
    .single()

  if (dbError || !sandbox) {
    return Response.json(
      { ok: false, error: "Invalid sandbox token" },
      { status: 401, headers: CORS_HEADERS },
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

  // Build path: support /v1/messages and sub-paths
  const url = new URL(req.url)
  const path = url.pathname.replace(/^\/llm-proxy/, "") || "/v1/messages"
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
