import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./config.js', () => ({
  config: {
    litellm: { proxyUrl: 'http://litellm:4000', masterKey: 'test-key' },
  },
}))

vi.mock('./log.js', () => ({
  logError: vi.fn(),
}))

import { llmProxy } from './llm-proxy.js'

function createMockContext(opts: {
  method?: string
  path?: string
  url?: string
  headers?: Record<string, string>
  body?: any
}) {
  const headers = opts.headers ?? {}
  return {
    req: {
      method: opts.method ?? 'POST',
      path: opts.path ?? '/v1/messages',
      url: opts.url ?? `http://localhost${opts.path ?? '/v1/messages'}`,
      header: vi.fn((name: string) => headers[name] ?? headers[name.toLowerCase()]),
      raw: { body: opts.body ?? null },
    },
    json: vi.fn((body: any, status?: number) => ({ __json: true, body, status: status ?? 200 })),
  } as any
}

describe('llmProxy', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns 401 when no auth token provided', async () => {
    const c = createMockContext({ headers: {} })
    const result = await llmProxy(c)
    expect(result.__json).toBe(true)
    expect(result.status).toBe(401)
    expect(result.body.error).toContain('Missing authentication')
  })

  it('extracts token from x-api-key header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    )

    const c = createMockContext({
      headers: { 'x-api-key': 'sk-test-123' },
    })
    await llmProxy(c)

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.any(Headers),
      })
    )
    const callHeaders = (globalThis.fetch as any).mock.calls[0][1].headers as Headers
    expect(callHeaders.get('Authorization')).toBe('Bearer sk-test-123')
  })

  it('extracts token from Authorization: Bearer header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    )

    const c = createMockContext({
      headers: { 'Authorization': 'Bearer my-token' },
    })
    await llmProxy(c)

    const callHeaders = (globalThis.fetch as any).mock.calls[0][1].headers as Headers
    expect(callHeaders.get('Authorization')).toBe('Bearer my-token')
  })

  it('extracts token from x-goog-api-key header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    )

    const c = createMockContext({
      headers: { 'x-goog-api-key': 'google-key' },
    })
    await llmProxy(c)

    const callHeaders = (globalThis.fetch as any).mock.calls[0][1].headers as Headers
    expect(callHeaders.get('Authorization')).toBe('Bearer google-key')
  })

  it('maps /v1/messages to /anthropic/v1/messages', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    )

    const c = createMockContext({
      path: '/v1/messages',
      headers: { 'x-api-key': 'key' },
    })
    await llmProxy(c)

    const url = (globalThis.fetch as any).mock.calls[0][0]
    expect(url).toBe('http://litellm:4000/anthropic/v1/messages')
  })

  it('maps /chat/completions as-is', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    )

    const c = createMockContext({
      path: '/chat/completions',
      headers: { 'x-api-key': 'key' },
    })
    await llmProxy(c)

    const url = (globalThis.fetch as any).mock.calls[0][0]
    expect(url).toBe('http://litellm:4000/chat/completions')
  })

  it('forwards anthropic-version and anthropic-beta headers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    )

    const c = createMockContext({
      headers: {
        'x-api-key': 'key',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'tools-2024-05-16',
      },
    })
    await llmProxy(c)

    const callHeaders = (globalThis.fetch as any).mock.calls[0][1].headers as Headers
    expect(callHeaders.get('anthropic-version')).toBe('2023-06-01')
    expect(callHeaders.get('anthropic-beta')).toBe('tools-2024-05-16')
  })

  it('returns 502 when upstream fetch fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'))

    const c = createMockContext({
      headers: { 'x-api-key': 'key' },
    })
    const result = await llmProxy(c)

    expect(result.__json).toBe(true)
    expect(result.status).toBe(502)
    expect(result.body.error).toContain('LLM proxy error')
    expect(result.body.error).toContain('connection refused')
  })
})

