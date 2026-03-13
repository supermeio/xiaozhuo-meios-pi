import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { config } from './config.js'
import { authMiddleware } from './auth.js'
import { proxyToSandbox } from './proxy.js'
import { llmProxy } from './llm-proxy.js'
import { createApiKey, listApiKeys, revokeApiKey } from './api-keys.js'
import { getSandboxUrl } from './sandbox-url.js'
import { log } from './log.js'

const app = new Hono()

// ── CORS ──
app.use('*', cors({
  origin: process.env.CORS_ORIGIN ?? '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-goog-api-key', 'anthropic-version', 'anthropic-beta'],
}))

// ── Public routes ──

app.get('/ping', (c) => {
  return c.json({ ok: true, data: { version: '0.1.0' } })
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

// ── Start ──

serve({ fetch: app.fetch, port: config.port }, (info) => {
  log('gateway', 'meios auth gateway running', {
    port: info.port,
    supabase: config.supabase.url,
  })
})
