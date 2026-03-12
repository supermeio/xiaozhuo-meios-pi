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
  litellm: {
    proxyUrl: process.env.LITELLM_PROXY_URL
      ?? 'https://litellm-proxy-932630247740.us-central1.run.app',
    masterKey: required('LITELLM_MASTER_KEY'),
  },
  meios: {
    repoUrl: process.env.MEIOS_REPO_URL ?? 'https://github.com/supermeio/xiaozhuo-meios-pi.git',
    // LLM proxy URL for sandboxes (Supabase Edge Function — whitelisted by Daytona)
    llmProxyUrl: process.env.MEIOS_LLM_PROXY_URL
      ?? `${required('SUPABASE_URL')}/functions/v1/llm-proxy`,
    gatewayPort: 18800,
  },
} as const
