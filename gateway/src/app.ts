import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authMiddleware } from './auth.js'
import { proxyToSandbox } from './proxy.js'
import { llmProxy } from './llm-proxy.js'
import { createApiKey, listApiKeys, revokeApiKey } from './api-keys.js'
import { getSandboxUrl } from './sandbox-url.js'
import { sandboxAuthMiddleware, presignUpload, deleteObject, listObjects } from './sync-api.js'

export const app = new Hono()

// ── CORS ──
app.use('*', cors({
  origin: process.env.CORS_ORIGIN ?? '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Machine-Secret', 'x-api-key', 'x-goog-api-key', 'anthropic-version', 'anthropic-beta'],
}))

// ── Public routes ──

app.get('/ping', (c) => {
  return c.json({ ok: true, data: { version: '0.1.0' } })
})

// SSE test endpoint — verifies streaming works through domain mapping
app.get('/sse-test', (c) => {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      for (let i = 1; i <= 5; i++) {
        controller.enqueue(encoder.encode(`data: {"n":${i}}\n\n`))
        await new Promise(r => setTimeout(r, 500))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
})

// ── LLM proxy (LiteLLM virtual key auth, not JWT) ──
// All routes relay to LiteLLM which handles auth, rate limiting, budget, routing.

app.post('/v1/messages', llmProxy)
app.post('/v1/messages/*', llmProxy)
app.post('/chat/completions', llmProxy)
app.post('/v1/chat/completions', llmProxy)
app.post('/openai/*', llmProxy)
app.post('/google/*', llmProxy)
app.post('/moonshot/*', llmProxy)

// ── Sandbox-to-gateway internal API (authenticated by machine secret) ──

app.use('/internal/v1/*', sandboxAuthMiddleware)
app.post('/internal/v1/sync/presign', presignUpload)
app.delete('/internal/v1/sync/object', deleteObject)
app.get('/internal/v1/sync/list', listObjects)

// ── Authenticated routes ──

app.use('/api/*', authMiddleware)
app.use('/*', authMiddleware)

// ── API v1: developer/agent endpoints ──

app.post('/api/v1/keys', createApiKey)
app.get('/api/v1/keys', listApiKeys)
app.delete('/api/v1/keys/:id', revokeApiKey)
app.get('/api/v1/sandbox/url', getSandboxUrl)

// ── Catch-all: proxy to sandbox ──

app.all('/*', proxyToSandbox)
