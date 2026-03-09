#!/usr/bin/env node
/**
 * meios gateway — lightweight HTTP API for wardrobe agent
 *
 * Endpoints:
 *   POST /chat    { message, sessionId? }  → { reply, sessionId }
 *   GET  /health                           → { ok, uptime }
 *   GET  /closet                           → { items[] }
 *   GET  /cron                             → { tasks[] }
 *
 * Usage:
 *   node --import tsx src/gateway.ts
 *   node --import tsx src/gateway.ts --port 3000
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createAgentSession, codingTools, SessionManager } from '@mariozechner/pi-coding-agent'
import { getModel } from '@mariozechner/pi-ai'
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { wardrobeTools, setWorkspaceRoot } from './tools.js'
import { initCron, listTasks } from './cron.js'
import { initHeartbeat } from './heartbeat.js'

// ── Config ──
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') ?? '18800')
const WORKSPACE = resolve(import.meta.dirname, '..', 'workspace')
const AGENT_DIR = resolve(import.meta.dirname, '..', '.meios-agent')
const SESSIONS_DIR = resolve(AGENT_DIR, 'sessions')

mkdirSync(AGENT_DIR, { recursive: true })
mkdirSync(SESSIONS_DIR, { recursive: true })
setWorkspaceRoot(WORKSPACE)

// ── Load API key ──
const authPath = resolve(AGENT_DIR, 'auth.json')
if (existsSync(authPath)) {
  const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
  if (auth.anthropic?.token && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = auth.anthropic.token
  }
}

// ── System prompt (includes heartbeat pending notes) ──
function loadSystemPrompt(): string {
  const parts: string[] = []
  const soulPath = resolve(WORKSPACE, 'SOUL.md')
  const memoryPath = resolve(WORKSPACE, 'MEMORY.md')
  if (existsSync(soulPath)) parts.push(readFileSync(soulPath, 'utf-8'))
  if (existsSync(memoryPath)) parts.push('---\n\n# 用户记忆\n\n' + readFileSync(memoryPath, 'utf-8'))

  // Inject heartbeat pending notes if any
  const pendingPath = resolve(WORKSPACE, 'memory', 'heartbeat-pending.md')
  if (existsSync(pendingPath)) {
    parts.push('---\n\n# 待主动告知用户的信息\n\n' + readFileSync(pendingPath, 'utf-8'))
    parts.push('（在合适的时机自然地提到这些信息，提到后可以删除这个文件）')
  }

  return parts.join('\n\n')
}

// ── Model ──
const model = getModel('anthropic', 'claude-haiku-4-5')

// ── Session cache ──
const sessionCache = new Map<string, any>()

async function getOrCreateSession(sessionId?: string) {
  if (sessionId && sessionCache.has(sessionId)) {
    return { session: sessionCache.get(sessionId)!, sessionId }
  }

  const sessDir = sessionId
    ? resolve(SESSIONS_DIR, sessionId)
    : resolve(SESSIONS_DIR, `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

  mkdirSync(sessDir, { recursive: true })

  let sessionManager: InstanceType<typeof SessionManager>
  try {
    sessionManager = SessionManager.continueRecent(WORKSPACE, sessDir)
  } catch {
    sessionManager = SessionManager.create(WORKSPACE, sessDir)
  }

  const { session } = await createAgentSession({
    cwd: WORKSPACE,
    agentDir: AGENT_DIR,
    model,
    tools: codingTools,
    customTools: wardrobeTools,
    thinkingLevel: 'minimal',
    sessionManager,
  })

  const id = sessDir.split('/').pop()!
  sessionCache.set(id, session)
  return { session, sessionId: id }
}

// ── Chat ──
async function chat(session: any, input: string): Promise<string> {
  const systemPrompt = loadSystemPrompt()

  return new Promise<string>((resolveText) => {
    const textChunks: string[] = []

    const unsub = session.subscribe((event: any) => {
      if (event.type === 'message_update') {
        const evt = event.assistantMessageEvent
        if (evt?.type === 'text_delta' && evt.delta) {
          textChunks.push(evt.delta)
        }
      }
      if (event.type === 'agent_end') {
        unsub()
        if (textChunks.length > 0) {
          resolveText(textChunks.join(''))
        } else {
          const text = (event.messages ?? [])
            .flatMap((m: any) => m.content ?? [])
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('')
          resolveText(text || '[无回复]')
        }
      }
    })

    session.prompt(input, { systemPrompt, abortSignal: undefined, images: [] })
  })
}

// ── HTTP helpers ──
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })
}

function json(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(JSON.stringify(data))
}

// ── Init cron & heartbeat ──
initCron(WORKSPACE)
initHeartbeat(WORKSPACE)

// ── Routes ──
const startTime = Date.now()

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  if (req.method === 'OPTIONS') { json(res, null, 204); return }

  try {
    // ── GET /health ──
    if (url.pathname === '/health' && req.method === 'GET') {
      const cronTasks = listTasks()
      json(res, {
        ok: true,
        uptime: Math.round((Date.now() - startTime) / 1000),
        model: model.id,
        workspace: WORKSPACE,
        activeSessions: sessionCache.size,
        cronTasks: cronTasks.length,
      })
      return
    }

    // ── GET /closet ──
    if (url.pathname === '/closet' && req.method === 'GET') {
      const dir = resolve(WORKSPACE, 'closet')
      if (!existsSync(dir)) { json(res, { items: [] }); return }

      const items = readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const content = readFileSync(join(dir, f), 'utf-8')
          const name = content.split('\n')[0]?.replace(/^#\s*/, '') ?? f
          return { id: f.replace('.md', ''), name, content }
        })
      json(res, { items })
      return
    }

    // ── GET /cron ──
    if (url.pathname === '/cron' && req.method === 'GET') {
      const tasks = listTasks().map(t => ({
        id: t.id,
        description: t.description,
        enabled: t.enabled,
        intervalMs: t.intervalMs,
        intervalHuman: `${Math.round(t.intervalMs / 1000 / 60)}m`,
        lastRun: t.lastRun ? new Date(t.lastRun).toISOString() : null,
      }))
      json(res, { tasks })
      return
    }

    // ── POST /chat ──
    if (url.pathname === '/chat' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const { message, sessionId: reqSessionId } = body

      if (!message || typeof message !== 'string') {
        json(res, { error: 'message is required' }, 400)
        return
      }

      const { session, sessionId } = await getOrCreateSession(reqSessionId)
      const reply = await chat(session, message)
      json(res, { reply, sessionId })
      return
    }

    json(res, { error: 'not found' }, 404)
  } catch (err: any) {
    console.error('[error]', err)
    json(res, { error: err.message ?? 'internal error' }, 500)
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🧥 meios gateway running`)
  console.log(`   http://0.0.0.0:${PORT}`)
  console.log(`   model: ${model.name} (${model.id})`)
  console.log(`   workspace: ${WORKSPACE}`)
  console.log(`   cron tasks: ${listTasks().length}`)
  console.log('')
  console.log(`Endpoints:`)
  console.log(`   GET  /health`)
  console.log(`   GET  /closet`)
  console.log(`   GET  /cron`)
  console.log(`   POST /chat   { message, sessionId? }`)
  console.log('')
})
