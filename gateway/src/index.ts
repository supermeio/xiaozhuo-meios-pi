import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { config } from './config.js'
import { authMiddleware } from './auth.js'
import { proxyToSandbox } from './proxy.js'
import { llmProxy } from './llm-proxy.js'
import { log } from './log.js'

const app = new Hono()

// ── CORS ──
app.use('*', cors({
  origin: process.env.CORS_ORIGIN ?? '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta'],
}))

// ── Public routes ──

app.get('/ping', (c) => {
  return c.json({ ok: true, data: { version: '0.1.0' } })
})

// ── LLM proxy (sandbox token auth, not JWT) ──

app.post('/v1/messages', llmProxy)
app.post('/v1/messages/*', llmProxy)

// ── Authenticated routes (proxy to sandbox) ──

app.use('/*', authMiddleware)
app.all('/*', proxyToSandbox)

// ── Start ──

serve({ fetch: app.fetch, port: config.port }, (info) => {
  log('gateway', 'meios auth gateway running', {
    port: info.port,
    supabase: config.supabase.url,
  })
})
