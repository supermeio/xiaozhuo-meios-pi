/**
 * Supabase Edge Function: LLM Proxy — Thin Relay to LiteLLM
 *
 * This Edge Function exists solely as a network hop: Daytona sandboxes
 * (Tier 1/2) can reach *.supabase.co but NOT *.run.app. So this relays
 * requests to the LiteLLM proxy on Cloud Run.
 *
 * LiteLLM handles everything: virtual key auth, rate limiting, budget
 * enforcement, provider routing, usage tracking, and cost calculation.
 *
 * Path mapping:
 *   /v1/messages*        → LiteLLM /anthropic/v1/messages* (pass-through)
 *   /chat/completions    → LiteLLM /chat/completions (OpenAI format)
 *   /v1/chat/completions → LiteLLM /v1/chat/completions
 *   /openai/*            → LiteLLM /openai/*
 *   (anything else)      → LiteLLM (forwarded as-is)
 */

const LITELLM_PROXY_URL = Deno.env.get("LITELLM_PROXY_URL")
  ?? "https://litellm-proxy-932630247740.us-central1.run.app"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-api-key, x-goog-api-key, anthropic-version, anthropic-beta",
}

/** Extract auth token from any header format the sandbox might use. */
function extractToken(req: Request): string | null {
  const xApiKey = req.headers.get("x-api-key")
  if (xApiKey) return xApiKey

  const googKey = req.headers.get("x-goog-api-key")
  if (googKey) return googKey

  const authHeader = req.headers.get("Authorization")
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7)

  const url = new URL(req.url)
  return url.searchParams.get("key")
}

/** Map incoming path to LiteLLM target path. */
function mapPath(path: string): string {
  // Anthropic native → LiteLLM Anthropic pass-through
  if (path.startsWith("/v1/messages")) return "/anthropic" + path
  // Everything else (OpenAI format, etc.) → forward as-is
  return path
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

  const token = extractToken(req)
  if (!token) {
    return Response.json(
      { ok: false, error: "Missing authentication token" },
      { status: 401, headers: CORS_HEADERS },
    )
  }

  // Extract path after /llm-proxy
  const url = new URL(req.url)
  const fnPath = url.pathname.replace(/^.*\/llm-proxy/, "") || "/v1/messages"
  const targetPath = mapPath(fnPath)
  const targetUrl = LITELLM_PROXY_URL + targetPath

  try {
    // Build headers: unified Bearer auth for LiteLLM virtual key
    const headers = new Headers()
    headers.set("Authorization", `Bearer ${token}`)

    const contentType = req.headers.get("Content-Type")
    if (contentType) headers.set("Content-Type", contentType)

    // Forward Anthropic-specific headers for pass-through
    const anthropicVersion = req.headers.get("anthropic-version")
    if (anthropicVersion) headers.set("anthropic-version", anthropicVersion)
    const anthropicBeta = req.headers.get("anthropic-beta")
    if (anthropicBeta) headers.set("anthropic-beta", anthropicBeta)

    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: req.body,
    })

    const respContentType = upstream.headers.get("Content-Type") ?? "application/json"

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": respContentType, ...CORS_HEADERS },
    })
  } catch (err) {
    console.error("[llm-proxy] relay error:", err)
    return Response.json(
      { ok: false, error: `LLM proxy error: ${(err as Error).message}` },
      { status: 502, headers: CORS_HEADERS },
    )
  }
})
