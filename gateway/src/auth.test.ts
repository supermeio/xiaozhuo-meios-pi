import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before importing auth
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}))

vi.mock('./config.js', () => ({
  config: {
    supabase: {
      url: 'https://test.supabase.co',
      secretKey: 'test',
      jwksUrl: 'https://test.supabase.co/auth/v1/.well-known/jwks.json',
    },
  },
}))

vi.mock('./api-keys.js', () => ({
  lookupByApiKey: vi.fn(),
}))

describe('authMiddleware', () => {
  let authMiddleware: typeof import('./auth.js').authMiddleware
  let lookupByApiKey: any
  let jwtVerify: any

  beforeEach(async () => {
    vi.clearAllMocks()
    const authMod = await import('./auth.js')
    authMiddleware = authMod.authMiddleware
    const apiKeysMod = await import('./api-keys.js')
    lookupByApiKey = apiKeysMod.lookupByApiKey
    const joseMod = await import('jose')
    jwtVerify = joseMod.jwtVerify
  })

  function createMockContext(authHeader?: string) {
    const store = new Map<string, any>()
    return {
      req: {
        header: vi.fn((name: string) => {
          if (name === 'Authorization') return authHeader
          return undefined
        }),
      },
      json: vi.fn((body: any, status?: number) => ({ body, status: status ?? 200 })),
      set: vi.fn((key: string, value: any) => store.set(key, value)),
      get: vi.fn((key: string) => store.get(key)),
      _store: store,
    } as any
  }

  it('returns 401 when Authorization header is missing', async () => {
    const c = createMockContext(undefined)
    const next = vi.fn()

    const result = await authMiddleware(c, next)

    expect(result.status).toBe(401)
    expect(result.body.error).toContain('Missing or invalid Authorization header')
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 when Authorization header does not start with Bearer', async () => {
    const c = createMockContext('Basic abc123')
    const next = vi.fn()

    const result = await authMiddleware(c, next)

    expect(result.status).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('authenticates via API key when token starts with meios_', async () => {
    const c = createMockContext('Bearer meios_testkey123')
    const next = vi.fn()
    ;(lookupByApiKey as any).mockResolvedValue({ id: 'user-1', email: undefined })

    await authMiddleware(c, next)

    expect(lookupByApiKey).toHaveBeenCalledWith('meios_testkey123')
    expect(c.set).toHaveBeenCalledWith('user', { id: 'user-1', email: undefined })
    expect(next).toHaveBeenCalled()
  })

  it('returns 401 for invalid API key', async () => {
    const c = createMockContext('Bearer meios_badkey')
    const next = vi.fn()
    ;(lookupByApiKey as any).mockResolvedValue(null)

    const result = await authMiddleware(c, next)

    expect(result.status).toBe(401)
    expect(result.body.error).toContain('Invalid or expired API key')
    expect(next).not.toHaveBeenCalled()
  })

  it('authenticates via JWT when token does not start with meios_', async () => {
    const c = createMockContext('Bearer eyJhbGciOiJIUzI1NiJ9.test')
    const next = vi.fn()
    ;(jwtVerify as any).mockResolvedValue({
      payload: { sub: 'user-jwt-1', email: 'test@example.com' },
    })

    await authMiddleware(c, next)

    expect(jwtVerify).toHaveBeenCalled()
    expect(c.set).toHaveBeenCalledWith('user', expect.objectContaining({ id: 'user-jwt-1', email: 'test@example.com' }))
    expect(next).toHaveBeenCalled()
  })

  it('returns 401 when JWT has no sub claim', async () => {
    const c = createMockContext('Bearer eyJhbGciOiJIUzI1NiJ9.test')
    const next = vi.fn()
    ;(jwtVerify as any).mockResolvedValue({
      payload: { email: 'test@example.com' },
    })

    const result = await authMiddleware(c, next)

    expect(result.status).toBe(401)
    expect(result.body.error).toContain('missing sub')
  })

  it('returns 401 when JWT verification fails', async () => {
    const c = createMockContext('Bearer invalid-jwt-token')
    const next = vi.fn()
    ;(jwtVerify as any).mockRejectedValue(new Error('token expired'))

    const result = await authMiddleware(c, next)

    expect(result.status).toBe(401)
    expect(result.body.error).toContain('Authentication failed')
    expect(result.body.error).toContain('token expired')
  })
})
