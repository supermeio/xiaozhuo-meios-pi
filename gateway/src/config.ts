function required(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

export const config = {
  port: parseInt(process.env.PORT ?? '8080'),
  supabase: {
    url: required('SUPABASE_URL'),
    secretKey: required('SUPABASE_SECRET_KEY'),
    // JWKS endpoint for JWT verification (ECC P-256)
    get jwksUrl() { return `${this.url}/auth/v1/.well-known/jwks.json` },
  },
  daytona: {
    apiKey: required('DAYTONA_API_KEY'),
    apiUrl: process.env.DAYTONA_API_URL ?? 'https://app.daytona.io',
  },
  meios: {
    repoUrl: process.env.MEIOS_REPO_URL ?? 'https://github.com/supermeio/xiaozhuo-meios-pi.git',
    anthropicKey: required('ANTHROPIC_API_KEY'),
    geminiKey: process.env.GEMINI_API_KEY ?? '',
    openaiKey: process.env.OPENAI_API_KEY ?? '',
    kimiKey: process.env.KIMI_API_KEY ?? '',
    // LLM proxy URL for sandboxes (Supabase Edge Function — whitelisted by Daytona)
    llmProxyUrl: process.env.MEIOS_LLM_PROXY_URL
      ?? `${required('SUPABASE_URL')}/functions/v1/llm-proxy`,
    gatewayPort: 18800,
  },
} as const
