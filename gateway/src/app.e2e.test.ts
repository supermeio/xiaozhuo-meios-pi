import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock all external dependencies ──

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}))

vi.mock('./config.js', () => ({
  config: {
    port: 8080,
    supabase: {
      url: 'https://test.supabase.co',
      secretKey: 'test-secret',
      jwksUrl: 'https://test.supabase.co/auth/v1/.well-known/jwks.json',
    },
    litellm: { proxyUrl: 'http://localhost:4000', masterKey: 'test-master' },
    flyio: {
      apiToken: 'test-flyio-token',
      appName: 'meios-sandbox-test',
      region: 'iad',
      sandboxImage: 'registry.fly.io/meios-sandbox-test:latest',
      juicefsToken: '',
      juicefsVolume: 'meios-persistent',
      gcsKeyB64: '',
      gatewaySecret: 'test-gateway-secret',
    },
    meios: {
      repoUrl: 'https://github.com/test/repo.git',
      llmProxyUrl: 'https://test.supabase.co/functions/v1/llm-proxy',
      gatewayPort: 18800,
    },
  },
}))

vi.mock('./api-keys.js', () => ({
  lookupByApiKey: vi.fn(),
  createApiKey: vi.fn((c: any) => c.json({ ok: true, data: { id: 'key-1' } })),
  listApiKeys: vi.fn((c: any) => c.json({ ok: true, data: { keys: [] } })),
  revokeApiKey: vi.fn((c: any) => c.json({ ok: true, data: null })),
}))

vi.mock('./sandbox.js', () => ({
  resolveSandboxUrl: vi.fn(),
  forceRefreshSignedUrl: vi.fn(),
  provisionFlyMachine: vi.fn(),
}))

vi.mock('./db.js', () => ({
  getSupabase: vi.fn(),
  getSandboxByUserId: vi.fn(),
  upsertSandbox: vi.fn(),
  updateSignedUrl: vi.fn(),
}))

vi.mock('./flyio.js', () => ({
  createMachine: vi.fn(),
  startMachine: vi.fn(),
  stopMachine: vi.fn(),
  destroyMachine: vi.fn(),
  getMachine: vi.fn(),
  checkHealth: vi.fn(),
}))

vi.mock('./log.js', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

// ── Import after mocks ──

import { app } from './app.js'
import { jwtVerify } from 'jose'
import { lookupByApiKey } from './api-keys.js'
import { resolveSandboxUrl, provisionFlyMachine } from './sandbox.js'
import { getSandboxByUserId } from './db.js'

// Helper: make a request to the Hono app
function req(path: string, init?: RequestInit) {
  return app.request(path, init)
}

// Helper: set up JWT mock to authenticate as a user
function mockJwtAuth(userId = 'user-1', email = 'test@example.com') {
  ;(jwtVerify as any).mockResolvedValue({
    payload: { sub: userId, email },
  })
}

// Helper: set up API key mock to authenticate
function mockApiKeyAuth(userId = 'user-1') {
  ;(lookupByApiKey as any).mockResolvedValue({ id: userId })
}

describe('Gateway E2E', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Public routes ──

  describe('GET /ping', () => {
    it('returns ok with version', async () => {
      const res = await req('/ping')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ ok: true, data: { version: '0.1.0' } })
    })

    it('includes CORS headers', async () => {
      const res = await req('/ping')
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
    })
  })

  describe('CORS preflight', () => {
    it('responds to OPTIONS with CORS headers', async () => {
      const res = await req('/ping', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://example.com',
          'Access-Control-Request-Method': 'POST',
        },
      })
      // Hono cors middleware returns 204 for preflight
      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    })
  })

  // ── Auth enforcement ──

  describe('Authentication', () => {
    it('rejects unauthenticated requests to /api/* with 401', async () => {
      const res = await req('/api/v1/keys')
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.ok).toBe(false)
      expect(body.error).toContain('Missing or invalid Authorization')
    })

    it('rejects unauthenticated requests to catch-all with 401', async () => {
      const res = await req('/health')
      expect(res.status).toBe(401)
    })

    it('accepts valid JWT auth for /api/* routes', async () => {
      mockJwtAuth('user-1')
      const res = await req('/api/v1/keys', {
        headers: { 'Authorization': 'Bearer valid-jwt-token' },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
    })

    it('accepts valid API key auth for /api/* routes', async () => {
      mockApiKeyAuth('user-1')
      const res = await req('/api/v1/keys', {
        headers: { 'Authorization': 'Bearer meios_valid_key' },
      })
      expect(res.status).toBe(200)
    })
  })

  // ── LLM proxy routes ──

  describe('LLM proxy routes', () => {
    it('POST /v1/messages without auth returns 401', async () => {
      const res = await req('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [] }),
      })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toContain('Missing authentication')
    })

    it('POST /chat/completions without auth returns 401', async () => {
      const res = await req('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [] }),
      })
      expect(res.status).toBe(401)
    })

    it('POST /v1/chat/completions without auth returns 401', async () => {
      const res = await req('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
    })
  })

  // ── API key management routes ──

  describe('API key management', () => {
    it('POST /api/v1/keys creates a key', async () => {
      mockJwtAuth()
      const res = await req('/api/v1/keys', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer jwt',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'test-key' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.data.id).toBe('key-1')
    })

    it('GET /api/v1/keys lists keys', async () => {
      mockJwtAuth()
      const res = await req('/api/v1/keys', {
        headers: { 'Authorization': 'Bearer jwt' },
      })
      expect(res.status).toBe(200)
    })

    it('DELETE /api/v1/keys/:id revokes a key', async () => {
      mockJwtAuth()
      const res = await req('/api/v1/keys/key-1', {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer jwt' },
      })
      expect(res.status).toBe(200)
    })
  })

  // ── Sandbox URL and SSH ──

  describe('Sandbox endpoints', () => {
    it('GET /api/v1/sandbox/url returns sandbox URL', async () => {
      mockJwtAuth('user-1')
      ;(resolveSandboxUrl as any).mockResolvedValue({ url: 'https://meios-sandbox-test.fly.dev', machineId: 'machine-1' })
      ;(getSandboxByUserId as any).mockResolvedValue({
        port: 18800,
        signed_url_exp: null,
      })

      const res = await req('/api/v1/sandbox/url', {
        headers: { 'Authorization': 'Bearer jwt' },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.data.url).toBe('https://meios-sandbox-test.fly.dev')
      expect(body.data.endpoints).toHaveProperty('chat')
      expect(body.data.endpoints).toHaveProperty('health')
    })

    it('GET /api/v1/sandbox/url auto-provisions when no sandbox', async () => {
      mockJwtAuth('user-new')
      ;(resolveSandboxUrl as any).mockResolvedValue(null)
      ;(provisionFlyMachine as any).mockResolvedValue({
        sandbox: { daytona_id: 'machine-new' },
        signedUrl: 'https://meios-sandbox-test.fly.dev',
      })
      ;(getSandboxByUserId as any).mockResolvedValue({
        port: 18800,
        signed_url_exp: null,
      })

      const res = await req('/api/v1/sandbox/url', {
        headers: { 'Authorization': 'Bearer jwt' },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data.url).toBe('https://meios-sandbox-test.fly.dev')
    })
  })

  // ── Catch-all proxy ──

  describe('Catch-all proxy', () => {
    it('proxies authenticated requests to sandbox', async () => {
      mockJwtAuth('user-1')
      ;(resolveSandboxUrl as any).mockResolvedValue({ url: 'https://sandbox.example.com', machineId: 'machine-1' })

      // The proxy will call fetch() to forward to sandbox
      // We mock global fetch for this test
      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, data: { health: 'ok' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

      try {
        const res = await req('/health', {
          headers: { 'Authorization': 'Bearer jwt' },
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.ok).toBe(true)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('returns 503 when sandbox provision fails', async () => {
      mockJwtAuth('user-1')
      ;(resolveSandboxUrl as any).mockResolvedValue(null)
      ;(provisionFlyMachine as any).mockRejectedValue(new Error('Sandbox API down'))

      const res = await req('/some-path', {
        headers: { 'Authorization': 'Bearer jwt' },
      })
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error).toContain('provision')
    })
  })

  // ── Response format consistency ──

  describe('Response format', () => {
    it('all error responses follow { ok: false, error: string } format', async () => {
      // Unauthenticated request
      const res = await req('/api/v1/keys')
      const body = await res.json()
      expect(body).toHaveProperty('ok', false)
      expect(body).toHaveProperty('error')
      expect(typeof body.error).toBe('string')
    })

    it('all success responses follow { ok: true, data: ... } format', async () => {
      const res = await req('/ping')
      const body = await res.json()
      expect(body).toHaveProperty('ok', true)
      expect(body).toHaveProperty('data')
    })
  })

  // ── Route existence ──

  describe('Route existence', () => {
    it('GET requests to non-existent API routes still hit auth', async () => {
      const res = await req('/api/v1/nonexistent')
      expect(res.status).toBe(401) // Blocked by auth before 404
    })

    it('all LLM proxy routes are POST-only', async () => {
      // GET to LLM routes should fall through to auth middleware (catch-all)
      const res = await req('/v1/messages')
      expect(res.status).toBe(401) // catch-all requires auth
    })
  })
})
