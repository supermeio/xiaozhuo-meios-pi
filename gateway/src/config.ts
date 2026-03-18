function required(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

export const config = {
  port: parseInt(process.env.PORT ?? '8080'),
  sandboxProvider: (process.env.SANDBOX_PROVIDER ?? 'daytona') as 'daytona' | 'flyio',
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
    proxyUrl: required('LITELLM_PROXY_URL'),
    masterKey: required('LITELLM_MASTER_KEY'),
  },
  meios: {
    repoUrl: process.env.MEIOS_REPO_URL ?? 'https://github.com/supermeio/xiaozhuo-meios-pi.git',
    // LLM proxy URL for sandboxes (Supabase Edge Function — whitelisted by Daytona)
    llmProxyUrl: process.env.MEIOS_LLM_PROXY_URL
      ?? `${required('SUPABASE_URL')}/functions/v1/llm-proxy`,
    gatewayPort: 18800,
  },
  // Fly.io sandbox compute (replaces Daytona for production)
  flyio: {
    apiToken: process.env.FLYIO_API_TOKEN ?? '',
    appName: process.env.FLYIO_APP_NAME ?? 'meios-sandbox-test',
    region: process.env.FLYIO_REGION ?? 'iad',
    sandboxImage: process.env.FLYIO_SANDBOX_IMAGE
      ?? 'registry.fly.io/meios-sandbox-test:latest',
    juicefsToken: (process.env.JUICEFS_ACCESS_KEY ?? '').trim(),
    juicefsVolume: process.env.JUICEFS_VOLUME ?? 'meios-persistent',
    gcsKeyB64: (process.env.JUICEFS_GCS_KEY_B64 ?? '').trim(),
    gatewaySecret: process.env.GATEWAY_SECRET ?? '',
  },
  // R2 file sync (optional — sync disabled in sandbox if not configured)
  r2: process.env.R2_ENDPOINT ? {
    endpoint: process.env.R2_ENDPOINT,
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    bucket: process.env.R2_BUCKET ?? 'meios-images',
    publicUrl: process.env.R2_PUBLIC_URL ?? '',  // e.g. https://images.meios.ai
  } : undefined,
} as const
