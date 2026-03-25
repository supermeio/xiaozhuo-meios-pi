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
  litellm: {
    proxyUrl: required('LITELLM_PROXY_URL'),
    masterKey: required('LITELLM_MASTER_KEY'),
  },
  meios: {
    repoUrl: process.env.MEIOS_REPO_URL ?? 'https://github.com/supermeio/xiaozhuo-meios-pi.git',
    // LLM proxy URL for sandboxes (Supabase Edge Function)
    llmProxyUrl: process.env.MEIOS_LLM_PROXY_URL
      ?? `${required('SUPABASE_URL')}/functions/v1/llm-proxy`,
    gatewayPort: 18800,
    /** Public URL of this gateway (for sandboxes to call back) */
    gatewayUrl: process.env.MEIOS_GATEWAY_URL ?? '',
  },
  // Fly.io sandbox compute
  flyio: {
    apiToken: process.env.FLYIO_API_TOKEN ?? '',
    appName: process.env.FLYIO_APP_NAME ?? 'meios-sandbox-test',
    region: process.env.FLYIO_REGION ?? 'iad',
    sandboxImage: process.env.FLYIO_SANDBOX_IMAGE
      ?? 'registry.fly.io/meios-sandbox-test:latest',
    gatewaySecret: process.env.GATEWAY_SECRET ?? '',
  },
  // JuiceFS self-hosted: per-user PG schema + S3
  juicefs: {
    pgHost: process.env.SUPABASE_DB_HOST ?? 'db.exyqukzhnjhbypakhlsp.supabase.co',
    pgPort: process.env.SUPABASE_DB_PORT ?? '5432',
    pgDatabase: process.env.SUPABASE_DB_NAME ?? 'postgres',
    pgUser: process.env.SUPABASE_DB_USER ?? 'postgres',
    pgPassword: process.env.SUPABASE_DB_PASSWORD ?? '',
    s3Bucket: process.env.JUICEFS_S3_BUCKET ?? 'meios-juicefs',
    s3Region: process.env.JUICEFS_S3_REGION ?? 'us-east-1',
    // Admin AWS credentials for creating per-user IAM users
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
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
