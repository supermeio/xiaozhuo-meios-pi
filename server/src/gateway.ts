#!/usr/bin/env node
/**
 * meios gateway — lightweight HTTP API for wardrobe agent
 *
 * Endpoints:
 *   GET    /health                → { ok, data: { uptime, model, version } }
 *   POST   /chat                  → { ok, data: { reply, sessionId } }
 *   GET    /sessions              → { ok, data: { sessions: [...] } }
 *   GET    /sessions/:id/messages → { ok, data: { messages: [{role, text, content}] } }
 *   DELETE /sessions/:id          → { ok, data: null }
 *   GET    /closet                → { ok, data: { items: [...] } }
 *   GET    /files/*               → binary file from workspace
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
import { initSync } from './sync.js'
import { textToContentBlocks, parseJsonlMessages, type ParsedContentBlock, type ParsedMessage } from './parsers.js'

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
const WORKSPACE = process.env.MEIOS_WORKSPACE
  ? resolve(process.env.MEIOS_WORKSPACE)
  : resolve(PROJECT_ROOT, 'workspace')
const AGENT_DIR = resolve(PROJECT_ROOT, '.meios-agent')
const SESSIONS_DIR = resolve(AGENT_DIR, 'sessions')

mkdirSync(AGENT_DIR, { recursive: true })
mkdirSync(SESSIONS_DIR, { recursive: true })
setWorkspaceRoot(WORKSPACE)

// ── Load .env.token (persisted by provisioning / token rotation) ──
// This file is the source of truth — overrides Daytona env vars which
// may be stale (e.g. old token) or incomplete after sandbox restarts.
const envSearchPaths = [
  resolve(PROJECT_ROOT, '.env.token'),
  resolve(import.meta.dirname, '..', '.env.token'),
  resolve(import.meta.dirname, '..', '..', '.env.token'),
]
for (const envPath of envSearchPaths) {
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.+)$/)
      if (match) process.env[match[1]] = match[2]
    }
    break
  }
}

// ── Load auth.json (legacy) ──
const authPath = resolve(AGENT_DIR, 'auth.json')
if (existsSync(authPath)) {
  const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
  if (auth.anthropic?.token && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = auth.anthropic.token
  }
}

// ── Env normalization ────────────────────────────────────────
// Daytona may only persist ANTHROPIC_API_KEY after restarts.
// All providers share the same sandbox proxy token, so derive
// missing keys from the one that survived.
const proxyToken = process.env.ANTHROPIC_API_KEY
if (proxyToken) {
  // pi-ai SDK reads GEMINI_API_KEY for Google provider
  if (!process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = proxyToken
  if (!process.env.GOOGLE_API_KEY) process.env.GOOGLE_API_KEY = proxyToken
  if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = proxyToken
  if (!process.env.KIMI_API_KEY) process.env.KIMI_API_KEY = proxyToken
}

// Derive provider base URLs from ANTHROPIC_BASE_URL (all go through same proxy)
// OPENAI_BASE_URL must NOT include /openai/v1 — pi-ai appends /chat/completions,
// and LiteLLM treats /openai/* as direct pass-through to OpenAI (bypassing routing).
const proxyBase = process.env.ANTHROPIC_BASE_URL
if (proxyBase) {
  if (!process.env.GEMINI_BASE_URL) process.env.GEMINI_BASE_URL = proxyBase + '/google/v1beta'
  if (!process.env.OPENAI_BASE_URL) process.env.OPENAI_BASE_URL = proxyBase
  if (!process.env.KIMI_BASE_URL) process.env.KIMI_BASE_URL = proxyBase + '/moonshot'
}

// ── Model ───────────────────────────────────────────────────
// All LLM calls go through LiteLLM via OpenAI-compatible /chat/completions.
// LiteLLM routes to the actual provider based on model name.
// See docs/model-selection.md for why kimi-k2.5 was chosen.
//
// pi-ai's getModel() only knows built-in models, so we construct the model
// object manually. The "openai-completions" api type maps to /chat/completions
// which is what LiteLLM expects.
const model = {
  id: 'kimi-k2.5',
  name: 'Kimi K2.5',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  reasoning: true,
  input: ['text'] as string[],
  cost: { input: 0.6, output: 3.0, cacheRead: 0.1, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 8192,
}

// ── Init cron, heartbeat & file sync ────────────────────────
initCron(WORKSPACE)
initHeartbeat(WORKSPACE)
initSync(WORKSPACE).catch(err => console.error('[sync] init error:', err.message))

// ── Response helpers ────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
} as const

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  ...CORS_HEADERS,
} as const

function ok<T>(res: ServerResponse, data: T, status = 200) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify({ ok: true, data }))
}

function fail(res: ServerResponse, error: string, status = 400) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify({ ok: false, error }))
}

const MAX_BODY_SIZE = 524288 // 512 KB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_SIZE) {
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

// ── JSONL parsing (imported from parsers.ts) ────────────────

/**
 * Read all JSONL files in a session directory and parse messages.
 */
function readSessionMessages(sessDir: string): ParsedMessage[] {
  const files = readdirSync(sessDir).filter(f => f.endsWith('.jsonl')).sort()
  const allMessages: ParsedMessage[] = []

  for (const file of files) {
    const content = readFileSync(join(sessDir, file), 'utf-8')
    allMessages.push(...parseJsonlMessages(content, WORKSPACE))
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

const SESSION_ID_RE = /^s-\d+-[a-z0-9]+$/

async function getOrCreateSession(sessionId?: string) {
  if (sessionId && !SESSION_ID_RE.test(sessionId)) {
    throw new Error('Invalid session ID')
  }

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

interface ChatResult {
  reply: string
  content: ParsedContentBlock[]
}

async function chat(session: any, input: string): Promise<ChatResult> {
  const systemPrompt = loadSystemPrompt()

  return new Promise<ChatResult>((resolve) => {
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
        let text: string
        if (textChunks.length > 0) {
          text = textChunks.join('')
        } else {
          text = (event.messages ?? [])
            .flatMap((m: AgentMessage) => m.content ?? [])
            .filter((b: ContentBlock) => b.type === 'text')
            .map((b: ContentBlock) => b.text)
            .join('') || '[无回复]'
        }
        const content = textToContentBlocks(text, WORKSPACE)
        resolve({ reply: text, content })
      }
    })

    session.prompt(input, { systemPrompt, abortSignal: undefined, images: [] })
  })
}

// ── SSE Streaming Chat ──────────────────────────────────────

function chatStream(session: any, input: string, sessionId: string, res: ServerResponse): void {
  const systemPrompt = loadSystemPrompt()
  const textChunks: string[] = []

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    ...CORS_HEADERS,
  })

  function sendSSE(data: Record<string, unknown>) {
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  // Send session ID immediately
  sendSSE({ type: 'session', sessionId })

  const unsub = session.subscribe((event: AgentEvent) => {
    if (event.type === 'message_update') {
      const evt = (event as any).assistantMessageEvent
      if (evt?.type === 'text_delta' && evt.delta) {
        textChunks.push(evt.delta)
        sendSSE({ type: 'text-delta', delta: evt.delta })
      }
      // Detect tool call from LLM output
      if (evt?.type === 'toolcall_end') {
        const tc = evt.toolCall ?? evt.tool_call
        if (tc) {
          sendSSE({
            type: 'tool-start',
            toolName: tc.name ?? tc.tool_name ?? '',
            toolCallId: tc.id ?? tc.tool_call_id ?? '',
          })
        }
      }
    }

    if (event.type === 'tool_execution_start') {
      // Already sent tool-start on toolcall_end, skip duplicate
    }

    if (event.type === 'tool_execution_end') {
      const toolName = (event as any).toolName
      const toolCallId = (event as any).toolCallId
      const isError = (event as any).isError ?? false
      sendSSE({ type: 'tool-end', toolName, toolCallId, isError })

      // For generate_image: find the just-created image and send it immediately
      if (toolName === 'generate_image' && !isError) {
        try {
          // Scan image directories for the most recently created file
          const imageDirs = ['images', 'looks']
          let newestFile: { dir: string, name: string, mtime: number } | null = null
          for (const dir of imageDirs) {
            const dirPath = resolve(WORKSPACE, dir)
            if (!existsSync(dirPath)) continue
            for (const f of readdirSync(dirPath)) {
              const mtime = statSync(resolve(dirPath, f)).mtimeMs
              if (!newestFile || mtime > newestFile.mtime) {
                newestFile = { dir, name: f, mtime }
              }
            }
          }
          if (newestFile && Date.now() - newestFile.mtime < 60_000) {
              const filePath = `${newestFile.dir}/${newestFile.name}`
              const imageId = `img-${filePath.replace(/[^a-z0-9]/gi, '-')}`
              sendSSE({
                type: 'image',
                url: `/files/${filePath}`,
                imageId,
              })
          }
        } catch { /* ignore */ }
      }
    }

    if (event.type === 'agent_end') {
      unsub()
      let text: string
      if (textChunks.length > 0) {
        text = textChunks.join('')
      } else {
        text = ((event as any).messages ?? [])
          .flatMap((m: AgentMessage) => m.content ?? [])
          .filter((b: ContentBlock) => b.type === 'text')
          .map((b: ContentBlock) => b.text)
          .join('') || '[无回复]'
      }
      const content = textToContentBlocks(text, WORKSPACE)
      sendSSE({ type: 'done', reply: text, content })
      res.write('data: [DONE]\n\n')
      res.end()
    }
  })

  // Handle client disconnect
  res.on('close', () => { unsub() })

  session.prompt(input, { systemPrompt, abortSignal: undefined, images: [] })
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
      let rawBody: string
      try {
        rawBody = await readBody(req)
      } catch (err: any) {
        fail(res, err.message, 413)
        return
      }

      const body = JSON.parse(rawBody)
      const { message, sessionId: reqSessionId } = body

      if (!message || typeof message !== 'string') {
        fail(res, 'message is required', 400)
        return
      }

      let session: any, sessionId: string
      try {
        ({ session, sessionId } = await getOrCreateSession(reqSessionId))
      } catch (err: any) {
        fail(res, err.message, 400)
        return
      }

      // SSE streaming if client requests it
      const wantsSSE = req.headers.accept?.includes('text/event-stream')
      if (wantsSSE) {
        chatStream(session, message, sessionId, res)
        return
      }

      const result = await chat(session, message)
      ok(res, { reply: result.reply, content: result.content, sessionId })
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
      if (!SESSION_ID_RE.test(sessId)) { fail(res, 'Invalid session ID', 400); return }
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
      if (!SESSION_ID_RE.test(sessId)) { fail(res, 'Invalid session ID', 400); return }
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

    // ── GET /files/* — serve workspace files (images, etc.) ──
    if (url.pathname.startsWith('/files/') && method === 'GET') {
      const relPath = decodeURIComponent(url.pathname.slice('/files/'.length))

      // Security: prevent path traversal
      if (relPath.includes('..') || relPath.startsWith('/')) {
        fail(res, 'Invalid path', 400)
        return
      }

      const absPath = resolve(WORKSPACE, relPath)

      // Ensure resolved path is within workspace
      if (!absPath.startsWith(WORKSPACE)) {
        fail(res, 'Access denied', 403)
        return
      }

      if (!existsSync(absPath)) {
        fail(res, 'File not found', 404)
        return
      }

      const ext = absPath.split('.').pop()?.toLowerCase() ?? ''
      const mimeTypes: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
      }
      const contentType = mimeTypes[ext] ?? 'application/octet-stream'
      const fileData = readFileSync(absPath)

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': fileData.length.toString(),
        'Cache-Control': 'public, max-age=86400',
        ...CORS_HEADERS,
      })
      res.end(fileData)
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
  console.log(`   GET    /files/*               workspace files`)
  console.log(`   GET    /cron`)
  console.log('')
})
