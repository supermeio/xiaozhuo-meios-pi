import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { config } from './config.js'
import { authMiddleware } from './auth.js'
import { proxyToSandbox } from './proxy.js'

const app = new Hono()

// ── CORS ──
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// ── Public routes ──

app.get('/ping', (c) => {
  return c.json({ ok: true, data: { version: '0.1.0' } })
})

// ── Authenticated routes (proxy to sandbox) ──

app.use('/*', authMiddleware)
app.all('/*', proxyToSandbox)

// ── Start ──

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`meios auth gateway running`)
  console.log(`  http://0.0.0.0:${info.port}`)
  console.log(`  supabase: ${config.supabase.url}`)
  console.log('')
})
