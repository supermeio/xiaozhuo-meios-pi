import { describe, it, expect, beforeEach, afterEach } from 'vitest'

describe('config', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    // Reset module cache so config re-evaluates
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  function setRequiredEnv() {
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SECRET_KEY = 'test-secret'
    process.env.LITELLM_PROXY_URL = 'https://litellm.example.com'
    process.env.LITELLM_MASTER_KEY = 'litellm-master'
  }

  it('throws when a required env var is missing', async () => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SECRET_KEY

    // Dynamically import to trigger the top-level required() calls
    await expect(async () => {
      await import('./config.js?missing=' + Date.now())
    }).rejects.toThrow('Missing required env var')
  })

  it('loads config with required env vars set', async () => {
    setRequiredEnv()
    const { config } = await import('./config.js?ok=' + Date.now())

    expect(config.supabase.url).toBe('https://test.supabase.co')
    expect(config.supabase.secretKey).toBe('test-secret')
    expect(config.litellm.proxyUrl).toBe('https://litellm.example.com')
    expect(config.litellm.masterKey).toBe('litellm-master')
  })

  it('uses default port 8080 when PORT is not set', async () => {
    setRequiredEnv()
    delete process.env.PORT
    const { config } = await import('./config.js?port1=' + Date.now())
    expect(config.port).toBe(8080)
  })

  it('parses PORT from env', async () => {
    setRequiredEnv()
    process.env.PORT = '3000'
    const { config } = await import('./config.js?port2=' + Date.now())
    expect(config.port).toBe(3000)
  })

  it('derives jwksUrl from supabase url', async () => {
    setRequiredEnv()
    const { config } = await import('./config.js?jwks=' + Date.now())
    expect(config.supabase.jwksUrl).toBe('https://test.supabase.co/auth/v1/.well-known/jwks.json')
  })

  it('sets r2 to undefined when R2_ENDPOINT is not set', async () => {
    setRequiredEnv()
    delete process.env.R2_ENDPOINT
    const { config } = await import('./config.js?r2=' + Date.now())
    expect(config.r2).toBeUndefined()
  })

  it('populates r2 config when R2_ENDPOINT is set', async () => {
    setRequiredEnv()
    process.env.R2_ENDPOINT = 'https://r2.example.com'
    process.env.R2_ACCESS_KEY_ID = 'r2key'
    process.env.R2_SECRET_ACCESS_KEY = 'r2secret'
    process.env.R2_BUCKET = 'my-bucket'
    process.env.R2_PUBLIC_URL = 'https://cdn.example.com'
    const { config } = await import('./config.js?r2full=' + Date.now())
    expect(config.r2).toEqual({
      endpoint: 'https://r2.example.com',
      accessKeyId: 'r2key',
      secretAccessKey: 'r2secret',
      bucket: 'my-bucket',
      publicUrl: 'https://cdn.example.com',
    })
  })

  it('defaults meios gatewayPort to 18800', async () => {
    setRequiredEnv()
    const { config } = await import('./config.js?meios=' + Date.now())
    expect(config.meios.gatewayPort).toBe(18800)
  })
})
