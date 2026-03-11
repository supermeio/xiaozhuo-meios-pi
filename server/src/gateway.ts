#!/usr/bin/env node
/**
 * meios gateway — lightweight HTTP API for wardrobe agent
 *
 * Endpoints:
 *   GET    /health                → { ok, data: { uptime, model, version } }
 *   POST   /chat                  → { ok, data: { reply, sessionId } }
 *   GET    /sessions              → { ok, data: { sessions: [...] } }
 *   GET    /sessions/:id/messages → { ok, data: { messages: [{role, text}] } }
 *   DELETE /sessions/:id          → { ok, data: null }
 *   GET    /closet                → { ok, data: { items: [...] } }
 *   GET    /cron                  → { ok, data: { tasks: [...] } }
 *
 * Usage:
 *   node --import tsx src/gateway.ts
 *   node --import tsx src/gateway.ts --port 3000
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createAgentSession, codingTools, SessionManager } from '@mariozechner/pi-coding-agent'
import { getModel } from '@mariozechner/pi-ai'
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { wardrobeTools, setWorkspaceRoot } from './tools.js'
import { initCron, listTasks } from './cron.js'
import { initHeartbeat } from './heartbeat.js'

// ── pi-agent event types ────────────────────────────────────

interface ContentBlock {
  type: string
  text?: string
}

interface AgentMessage {
  content?: ContentBlock[]
}

interface AgentEvent {
  type: string
  assistantMessageEvent?: { type: string; delta?: string }
  messages?: AgentMessage[]
}

// ── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') ?? '18800')
const VERSION = '0.1.0'
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..')
const WORKSPACE = resolve(PROJECT_ROOT, 'workspace')
const AGENT_DIR = resolve(PROJECT_ROOT, '.meios-agent')
const SESSIONS_DIR = resolve(AGENT_DIR, 'sessions')

mkdirSync(AGENT_DIR, { recursive: true })
mkdirSync(SESSIONS_DIR, { recursive: true })
setWorkspaceRoot(WORKSPACE)

// ── Load API key ────────────────────────────────────────────
const authPath = resolve(AGENT_DIR, 'auth.json')
if (existsSync(authPath)) {
  const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
  if (auth.anthropic?.token && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = auth.anthropic.token
  }
}

// ── Model ───────────────────────────────────────────────────
const model = getModel('anthropic', 'claude-haiku-4-5')

// pi-ai SDK hardcodes baseUrl in getModel(). Override to route through
// LLM proxy so the real API key never enters the sandbox.
// Track: https://github.com/mariozechner/pi-ai/issues/XXX (SDK limitation)
if (process.env.ANTHROPIC_BASE_URL) {
  ;(model as any).baseUrl = process.env.ANTHROPIC_BASE_URL
}

// ── Init cron & heartbeat ───────────────────────────────────
initCron(WORKSPACE)
initHeartbeat(WORKSPACE)

// ── Response helpers ────────────────────────────────────────

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const

function ok<T>(res: ServerResponse, data: T, status = 200) {
  res.writeHead(status, CORS_HEADERS)
  res.end(JSON.stringify({ ok: true, data }))
}

function fail(res: ServerResponse, error: string, status = 400) {
  res.writeHead(status, CORS_HEADERS)
  res.end(JSON.stringify({ ok: false, error }))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })
}

// ── JSONL parsing ───────────────────────────────────────────

interface ParsedMessage {
  role: 'user' | 'assistant'
  text: string
}

/**
 * Parse a session JSONL file and extract user/assistant messages.
 *
 * JSONL line format:
 *   {"type":"message","id":"...","message":{"role":"user|assistant","content":[...]}}
 *
 * Content blocks can be:
 *   {"type":"text","text":"..."}       — we keep these
 *   {"type":"thinking","thinking":"..."} — we skip these
 *   {"type":"toolCall",...}             — we skip these
 *   {"type":"toolResult",...}           — we skip these (role === "toolResult")
 */
function parseJsonlMessages(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = []
  const lines = content.split('\n').filter(Boolean)

  for (const line of lines) {
    try {
      const entry = JSON.parse(line)

      // Only process lines with type === "message"
      if (entry.type !== 'message') continue

      const msg = entry.message
      if (!msg || !msg.role || !msg.content) continue

      // Only user and assistant messages
      if (msg.role !== 'user' && msg.role !== 'assistant') continue

      const blocks = Array.isArray(msg.content) ? msg.content : [msg.content]

      // Extract text from content blocks, skip thinking/toolCall/etc
      const text = blocks
        .filter((b: ContentBlock) => b.type === 'text' && typeof b.text === 'string')
        .map((b: ContentBlock) => b.text)
        .join('\n')

      // Skip empty text results
      if (!text.trim()) continue

      messages.push({ role: msg.role, text })
    } catch {
      // Skip malformed lines
    }
  }

  return messages
}

/**
 * Read all JSONL files in a session directory and parse messages.
 */
function readSessionMessages(sessDir: string): ParsedMessage[] {
  const files = readdirSync(sessDir).filter(f => f.endsWith('.jsonl')).sort()
  const allMessages: ParsedMessage[] = []

  for (const file of files) {
    const content = readFileSync(join(sessDir, file), 'utf-8')
    allMessages.push(...parseJsonlMessages(content))
  }

  return allMessages
}

/**
 * Get preview text and message count for a session directory.
 */
function getSessionSummary(sessDir: string): { preview: string; messageCount: number } {
  const messages = readSessionMessages(sessDir)
  const firstUserMessage = messages.find(m => m.role === 'user')
  const preview = firstUserMessage ? firstUserMessage.text.slice(0, 80) : ''
  return { preview, messageCount: messages.length }
}

// ── System prompt ───────────────────────────────────────────

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

// ── Session cache ───────────────────────────────────────────

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

// ── Chat ────────────────────────────────────────────────────

async function chat(session: any, input: string): Promise<string> {
  const systemPrompt = loadSystemPrompt()

  return new Promise<string>((resolveText) => {
    const textChunks: string[] = []

    const unsub = session.subscribe((event: AgentEvent) => {
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
            .flatMap((m: AgentMessage) => m.content ?? [])
            .filter((b: ContentBlock) => b.type === 'text')
            .map((b: ContentBlock) => b.text)
            .join('')
          resolveText(text || '[无回复]')
        }
      }
    })

    session.prompt(input, { systemPrompt, abortSignal: undefined, images: [] })
  })
}

// ── Route matching ──────────────────────────────────────────

const startTime = Date.now()

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const method = req.method ?? 'GET'

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }

  try {
    // ── GET /health ──
    if (url.pathname === '/health' && method === 'GET') {
      ok(res, {
        uptime: Math.round((Date.now() - startTime) / 1000),
        model: model.id,
        version: VERSION,
        workspace: WORKSPACE,
        activeSessions: sessionCache.size,
        cronTasks: listTasks().length,
      })
      return
    }

    // ── POST /chat ──
    if (url.pathname === '/chat' && method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const { message, sessionId: reqSessionId } = body

      if (!message || typeof message !== 'string') {
        fail(res, 'message is required', 400)
        return
      }

      const { session, sessionId } = await getOrCreateSession(reqSessionId)
      const reply = await chat(session, message)
      ok(res, { reply, sessionId })
      return
    }

    // ── GET /sessions ──
    if (url.pathname === '/sessions' && method === 'GET') {
      const dirs = existsSync(SESSIONS_DIR)
        ? readdirSync(SESSIONS_DIR).filter(d => d.startsWith('s-'))
        : []

      const sessions = dirs.map(d => {
        const dirPath = resolve(SESSIONS_DIR, d)
        const stat = statSync(dirPath)
        const { preview, messageCount } = getSessionSummary(dirPath)

        return {
          id: d,
          preview,
          messageCount,
          createdAt: new Date(stat.birthtime).toISOString(),
          updatedAt: new Date(stat.mtime).toISOString(),
          isActive: sessionCache.has(d),
        }
      }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

      ok(res, { sessions })
      return
    }

    // ── GET /sessions/:id/messages ──
    const messagesMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/)
    if (messagesMatch && method === 'GET') {
      const sessId = messagesMatch[1]
      const sessDir = resolve(SESSIONS_DIR, sessId)

      if (!existsSync(sessDir)) {
        fail(res, 'session not found', 404)
        return
      }

      const messages = readSessionMessages(sessDir)
      ok(res, { messages })
      return
    }

    // ── DELETE /sessions/:id ──
    const deleteMatch = url.pathname.match(/^\/sessions\/([^/]+)$/)
    if (deleteMatch && method === 'DELETE') {
      const sessId = deleteMatch[1]
      const sessDir = resolve(SESSIONS_DIR, sessId)

      if (!existsSync(sessDir)) {
        fail(res, 'session not found', 404)
        return
      }

      // Remove from cache if active
      sessionCache.delete(sessId)

      // Remove the session directory
      rmSync(sessDir, { recursive: true, force: true })
      ok(res, null)
      return
    }

    // ── GET /closet ──
    if (url.pathname === '/closet' && method === 'GET') {
      const dir = resolve(WORKSPACE, 'closet')
      if (!existsSync(dir)) {
        ok(res, { items: [] })
        return
      }

      const items = readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const content = readFileSync(join(dir, f), 'utf-8')
          const name = content.split('\n')[0]?.replace(/^#\s*/, '') ?? f
          return { id: f.replace('.md', ''), name, content }
        })

      ok(res, { items })
      return
    }

    // ── GET /cron ──
    if (url.pathname === '/cron' && method === 'GET') {
      const tasks = listTasks().map(t => ({
        id: t.id,
        description: t.description,
        enabled: t.enabled,
        intervalMs: t.intervalMs,
        intervalHuman: `${Math.round(t.intervalMs / 1000 / 60)}m`,
        lastRun: t.lastRun ? new Date(t.lastRun).toISOString() : null,
      }))

      ok(res, { tasks })
      return
    }

    // ── 404 ──
    fail(res, 'not found', 404)
  } catch (err: any) {
    console.error('[error]', err)
    fail(res, err.message ?? 'internal error', 500)
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`meios gateway running`)
  console.log(`   http://0.0.0.0:${PORT}`)
  console.log(`   model: ${model.name} (${model.id})`)
  console.log(`   workspace: ${WORKSPACE}`)
  console.log(`   version: ${VERSION}`)
  console.log(`   cron tasks: ${listTasks().length}`)
  console.log('')
  console.log(`Endpoints:`)
  console.log(`   GET    /health`)
  console.log(`   POST   /chat                  { message, sessionId? }`)
  console.log(`   GET    /sessions`)
  console.log(`   GET    /sessions/:id/messages`)
  console.log(`   DELETE /sessions/:id`)
  console.log(`   GET    /closet`)
  console.log(`   GET    /cron`)
  console.log('')
})
