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
 *   GET    /collections           → { ok, data: { collections: [...] } }
 *   GET    /collections/:id       → { ok, data: { collection, images: [...] } }
 *   POST   /collections           → { ok, data: { collection } }
 *   POST   /collections/:id/images → { ok, data: null }
 *   DELETE /collections/:id/images/:imgId → { ok, data: null }
 *   DELETE /collections/:id       → { ok, data: null }
 *   GET    /files/*               → binary file from workspace
 *   GET    /cron                  → { ok, data: { tasks: [...] } }
 *
 * Usage:
 *   node --import tsx src/gateway.ts
 *   node --import tsx src/gateway.ts --port 3000
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { logger } from './log.js'

const log = logger.getSubLogger({ name: 'gateway' })
import { createAgentSession, codingTools, SessionManager, DefaultResourceLoader, SettingsManager } from '@mariozechner/pi-coding-agent'
import { getModel } from '@mariozechner/pi-ai'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { wardrobeTools, setWorkspaceRoot } from './tools.js'
import { initCron, listTasks } from './cron.js'
import { initHeartbeat } from './heartbeat.js'
import { initSync, getImageUrl, ensureUploaded } from './sync.js'
import { textToContentBlocks, parseJsonlMessages, type ParsedContentBlock, type ParsedMessage } from './parsers.js'
import {
  listCollectionsWithCounts,
  getCollection,
  createCollection,
  deleteCollection,
  listCollectionImages,
  addToCollection,
  removeFromCollection,
  registerImage,
  getImageByPath,
  scanAndRegister,
  listImages,
} from './collections.js'

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
// NOTE: setWorkspaceRoot(WORKSPACE) is deferred to after server.listen()
// to avoid slow JuiceFS I/O blocking server startup. See deferredInit() below.

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
  input: ['text'] as ("text" | "image")[],
  cost: { input: 0.6, output: 3.0, cacheRead: 0.1, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 8192,
}

// ── Deferred init: JuiceFS-touching code runs after server.listen() ──
// Each JuiceFS file operation (existsSync, mkdirSync, readFileSync, etc.) goes through
// FUSE → PG metadata query (~600ms latency). Deferring this lets the HTTP server
// start accepting /health checks immediately while workspace init happens in background.
let _workspaceReady = false
function deferredInit() {
  const t0 = Date.now()
  log.info('deferred workspace init starting...')

  setWorkspaceRoot(WORKSPACE)
  log.info('setWorkspaceRoot done', { elapsed: Date.now() - t0 })

  initCron(WORKSPACE)
  log.info('initCron done', { elapsed: Date.now() - t0 })

  initHeartbeat(WORKSPACE)
  log.info('initHeartbeat done', { elapsed: Date.now() - t0 })

  _workspaceReady = true
  log.info('workspace ready', { elapsed: Date.now() - t0 })

  initSync(WORKSPACE).catch(err => log.error('sync init error', { error: err.message }))
}

// ── Pre-create resource loader (skip all discovery to avoid slow JuiceFS scans) ──
const settingsManager = SettingsManager.create(AGENT_DIR, AGENT_DIR)
const resourceLoader = new DefaultResourceLoader({
  cwd: AGENT_DIR,          // Use ephemeral dir, NOT /persistent (JuiceFS)
  agentDir: AGENT_DIR,
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
})
// Skip reload() — we don't need skills/extensions/prompts/themes.
// System prompt is set via session.agent.setSystemPrompt() per request.

// ── Response helpers ────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, X-Gateway-Secret',
} as const

// ── Auth: gateway secret or user JWT ────────────────────────
const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? ''
const MEIOS_USER_ID = process.env.MEIOS_USER_ID ?? ''
const IS_DEV = process.env.NODE_ENV === 'development' || process.env.MEIOS_DEV === '1'

// Fail-closed: refuse to start without GATEWAY_SECRET in production
if (!GATEWAY_SECRET && !IS_DEV) {
  log.fatal('GATEWAY_SECRET is not set — refusing to start without auth secret in production')
  log.fatal('Set GATEWAY_SECRET, or set NODE_ENV=development / MEIOS_DEV=1 for local dev')
  process.exit(1)
}

/** Get CDN URL for an image path, falling back to /files/ for dev mode. */
function cdnUrl(filePath: string): string {
  if (MEIOS_USER_ID) {
    const r2Url = getImageUrl(MEIOS_USER_ID, filePath)
    if (r2Url) return r2Url
  }
  return `/files/${filePath}`
}

function checkAuth(req: IncomingMessage): boolean {
  // In dev mode with no secret, allow all requests
  if (!GATEWAY_SECRET && IS_DEV) return true

  // Fail closed: no secret configured → deny (should not reach here in prod due to boot check)
  if (!GATEWAY_SECRET) return false

  // Check X-Gateway-Secret header (from outer gateway)
  const secret = req.headers['x-gateway-secret']
  if (secret === GATEWAY_SECRET) return true

  // Check Authorization: Bearer <token> (from user tools)
  // For now, accept any bearer token that matches the gateway secret
  // TODO: upgrade to JWT validation with user ownership check
  const auth = req.headers['authorization']
  if (auth?.startsWith('Bearer ') && auth.slice(7) === GATEWAY_SECRET) return true

  return false
}

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

// ── Meio type resolution ─────────────────────────────────────

/**
 * Resolve SOUL.md path for a meio type.
 * - meioType provided: /persistent/meios/{type}/SOUL.md
 * - no meioType: /persistent/SOUL.md (legacy single-meio mode)
 */
function resolveSoulPath(meioType?: string): string {
  if (meioType) {
    const typed = resolve(WORKSPACE, 'meios', meioType, 'SOUL.md')
    if (existsSync(typed)) return typed
  }
  return resolve(WORKSPACE, 'SOUL.md')
}

// ── System prompt ───────────────────────────────────────────

function loadSystemPrompt(meioType?: string): string {
  const parts: string[] = []
  const soulPath = resolveSoulPath(meioType)
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

/**
 * Resolve custom tools for a meio type.
 * - 'wardrobe' or undefined: wardrobe-specific tools
 * - other types: coding tools only (bash/read/write/edit are sufficient)
 */
function resolveCustomTools(meioType?: string) {
  if (meioType === 'wardrobe') return wardrobeTools
  return []  // coding tools (read, write, edit, bash) are always included
}

async function getOrCreateSession(sessionId?: string, meioType?: string) {
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

  let sessionManager: SessionManager
  try {
    sessionManager = SessionManager.continueRecent(WORKSPACE, sessDir)
  } catch {
    sessionManager = SessionManager.create(WORKSPACE, sessDir)
  }

  const { session } = await createAgentSession({
    cwd: AGENT_DIR,          // Use ephemeral dir to avoid JuiceFS scans
    agentDir: AGENT_DIR,
    model,
    tools: codingTools,
    customTools: resolveCustomTools(meioType),
    thinkingLevel: 'minimal',
    sessionManager,
    resourceLoader,
    settingsManager,
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

async function chat(session: any, input: string, meioType?: string): Promise<ChatResult> {
  session.agent.setSystemPrompt(loadSystemPrompt(meioType))

  return new Promise<ChatResult>((resolve, reject) => {
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

    session.prompt(input, { images: [] })
  })
}

// ── SSE Streaming Chat ──────────────────────────────────────

function chatStream(session: any, input: string, sessionId: string, res: ServerResponse, meioType?: string): void {
  const t0 = Date.now()
  log.info('loadSystemPrompt start', { meioType })
  const systemPrompt = loadSystemPrompt(meioType)
  log.info('loadSystemPrompt done', { elapsed: Date.now() - t0 })

  // Set system prompt on the agent (PromptOptions doesn't accept systemPrompt)
  session.agent.setSystemPrompt(systemPrompt)

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

  // SSE keepalive: send comment every 20s to prevent Cloud Run / proxy timeout
  const heartbeat = setInterval(() => {
    try { res.write(': keepalive\n\n') } catch { /* connection already closed */ }
  }, 20_000)

  // Send session ID immediately
  sendSSE({ type: 'session', sessionId })
  log.info('session.prompt() about to call', { elapsed: Date.now() - t0 })

  let firstEventLogged = false
  let firstTextDelta = false
  const unsub = session.subscribe((event: AgentEvent) => {
    if (!firstEventLogged) {
      log.info('first agent event', { type: event.type, elapsed: Date.now() - t0 })
      firstEventLogged = true
    }
    // Log key lifecycle events for timing analysis
    if (event.type === 'message_start') {
      const role = (event as any).message?.role
      log.info('message_start', { role, elapsed: Date.now() - t0 })
    }
    if (event.type === 'turn_start') {
      log.info('turn_start', { elapsed: Date.now() - t0 })
    }
    if (event.type === 'message_update') {
      const evt = (event as any).assistantMessageEvent
      if (evt?.type === 'text_delta' && evt.delta) {
        if (!firstTextDelta) {
          log.info('first text_delta', { elapsed: Date.now() - t0 })
          firstTextDelta = true
        }
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

      // For generate_image: find the just-created image, upload to CDN, then send URL
      if (toolName === 'generate_image' && !isError) {
        (async () => {
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
                // Upload to CDN with 30s timeout; fall back to /files/ URL on failure
                try {
                  await Promise.race([
                    ensureUploaded(WORKSPACE, filePath),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('upload timeout')), 30_000)),
                  ])
                } catch (uploadErr: any) {
                  log.error('ensureUploaded failed, falling back to /files/', { error: (uploadErr as Error).message })
                }
                const imageId = `img-${filePath.replace(/[^a-z0-9]/gi, '-')}`
                sendSSE({
                  type: 'image',
                  url: cdnUrl(filePath),
                  imageId,
                })
            }
          } catch { /* ignore */ }
        })()
      }
    }

    if (event.type === 'agent_end') {
      unsub()
      clearInterval(heartbeat)
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

  // Handle client disconnect — abort the agent so isStreaming resets
  const abortController = new AbortController()
  res.on('close', () => {
    unsub()
    clearInterval(heartbeat)
    abortController.abort()
    session.abort().catch(() => {})
  })

  session.prompt(input, { images: [] })
    .catch((err: any) => {
      clearInterval(heartbeat)
      sendSSE({ type: 'error', message: err?.message ?? 'Agent prompt failed' })
      res.write('data: [DONE]\n\n')
      res.end()
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
    // ── Auth check (skip /health for Fly Proxy health checks) ──
    if (url.pathname !== '/health' && !checkAuth(req)) {
      fail(res, 'Unauthorized', 401)
      return
    }

    // ── GET /health ──
    if (url.pathname === '/health' && method === 'GET') {
      ok(res, {
        uptime: Math.round((Date.now() - startTime) / 1000),
        model: model.id,
        version: VERSION,
        workspace: WORKSPACE,
        workspaceReady: _workspaceReady,
        activeSessions: sessionCache.size,
      })
      return
    }

    // ── GET /meios — list available meio types ──
    if (url.pathname === '/meios' && method === 'GET') {
      const meios: { type: string; name: string; hasSoul: boolean }[] = []

      // Check for typed meios in /persistent/meios/*/SOUL.md
      const meiosDir = resolve(WORKSPACE, 'meios')
      if (existsSync(meiosDir)) {
        for (const entry of readdirSync(meiosDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const soulPath = resolve(meiosDir, entry.name, 'SOUL.md')
            meios.push({
              type: entry.name,
              name: entry.name,
              hasSoul: existsSync(soulPath),
            })
          }
        }
      }

      // Always include default (legacy root SOUL.md)
      const rootSoul = resolve(WORKSPACE, 'SOUL.md')
      if (existsSync(rootSoul)) {
        meios.unshift({ type: 'default', name: 'default', hasSoul: true })
      }

      ok(res, { meios })
      return
    }

    // ── POST /chat ──
    if (url.pathname === '/chat' && method === 'POST') {
      // Wait for workspace init if still in progress
      if (!_workspaceReady) {
        const waitStart = Date.now()
        while (!_workspaceReady && Date.now() - waitStart < 30_000) {
          await new Promise(r => setTimeout(r, 100))
        }
        if (!_workspaceReady) {
          fail(res, 'Workspace initialization timed out', 503)
          return
        }
      }
      const t0 = Date.now()
      log.info('chat request received')
      let rawBody: string
      try {
        rawBody = await readBody(req)
      } catch (err: any) {
        fail(res, err.message, 413)
        return
      }

      const body = JSON.parse(rawBody)
      const { message, sessionId: reqSessionId, meioType } = body

      if (!message || typeof message !== 'string') {
        fail(res, 'message is required', 400)
        return
      }

      // Validate meioType if provided (alphanumeric + hyphens only)
      if (meioType && (typeof meioType !== 'string' || !/^[a-z0-9-]+$/.test(meioType))) {
        fail(res, 'invalid meioType', 400)
        return
      }

      let session: any, sessionId: string
      try {
        log.info('getOrCreateSession start', { elapsed: Date.now() - t0, meioType });
        ({ session, sessionId } = await getOrCreateSession(reqSessionId, meioType))
        log.info('getOrCreateSession done', { elapsed: Date.now() - t0 })
      } catch (err: any) {
        fail(res, err.message, 400)
        return
      }

      // SSE streaming if client requests it
      const wantsSSE = req.headers.accept?.includes('text/event-stream')
      if (wantsSSE) {
        chatStream(session, message, sessionId, res, meioType)
        return
      }

      const result = await chat(session, message, meioType)
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

    // ── GET /images ──
    if (url.pathname === '/images' && method === 'GET') {
      const images = listImages().map(img => ({
        id: img.id,
        path: img.path,
        filename: img.filename,
        url: `/files/${img.path}`,
        sizeBytes: img.size_bytes,
        createdAt: img.created_at,
      }))
      ok(res, { images })
      return
    }

    // ── GET /collections ──
    if (url.pathname === '/collections' && method === 'GET') {
      const collections = listCollectionsWithCounts().map(c => {
        // Resolve cover image URL: use explicit cover or latest image in collection
        let coverUrl: string | null = null
        if (c.cover_image_id) {
          const coverImg = listCollectionImages(c.id).find(i => i.id === c.cover_image_id)
          if (coverImg) coverUrl = `/files/${coverImg.path}`
        }
        if (!coverUrl && c.image_count > 0) {
          const imgs = listCollectionImages(c.id)
          if (imgs.length > 0) coverUrl = `/files/${imgs[0].path}`
        }
        return {
          id: c.id,
          name: c.name,
          description: c.description,
          coverUrl,
          imageCount: c.image_count,
          createdAt: c.created_at,
          updatedAt: c.updated_at,
        }
      })
      ok(res, { collections })
      return
    }

    // ── POST /collections ──
    if (url.pathname === '/collections' && method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const { name, description } = body
      if (!name || typeof name !== 'string') {
        fail(res, 'name is required', 400)
        return
      }
      const collection = createCollection(name, description)
      ok(res, { collection })
      return
    }

    // ── GET /collections/:id ──
    const colMatch = url.pathname.match(/^\/collections\/([^/]+)$/)
    if (colMatch && method === 'GET') {
      const col = getCollection(colMatch[1])
      if (!col) { fail(res, 'collection not found', 404); return }

      const images = listCollectionImages(col.id).map(img => ({
        id: img.id,
        path: img.path,
        filename: img.filename,
        url: cdnUrl(img.path),
        sizeBytes: img.size_bytes,
        createdAt: img.created_at,
      }))
      ok(res, { collection: col, images })
      return
    }

    // ── DELETE /collections/:id ──
    if (colMatch && method === 'DELETE') {
      const deleted = deleteCollection(colMatch[1])
      if (!deleted) { fail(res, 'collection not found', 404); return }
      ok(res, null)
      return
    }

    // ── POST /collections/:id/images ──
    const colImgMatch = url.pathname.match(/^\/collections\/([^/]+)\/images$/)
    if (colImgMatch && method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const { imagePath } = body
      if (!imagePath || typeof imagePath !== 'string') {
        fail(res, 'imagePath is required', 400)
        return
      }

      const col = getCollection(colImgMatch[1])
      if (!col) { fail(res, 'collection not found', 404); return }

      const absPath = resolve(WORKSPACE, imagePath)
      if (!existsSync(absPath)) { fail(res, 'image not found', 404); return }

      let img = getImageByPath(imagePath)
      if (!img) img = registerImage(absPath)

      addToCollection(col.id, img.id)
      ok(res, null)
      return
    }

    // ── DELETE /collections/:id/images/:imgId ──
    const colImgDelMatch = url.pathname.match(/^\/collections\/([^/]+)\/images\/([^/]+)$/)
    if (colImgDelMatch && method === 'DELETE') {
      const [, colId, imgId] = colImgDelMatch
      removeFromCollection(colId, imgId)
      ok(res, null)
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

    // ── GET /fs — list directory contents ──
    if (url.pathname === '/fs' && method === 'GET') {
      const relPath = url.searchParams.get('path') || ''

      if (relPath.includes('..')) {
        fail(res, 'Invalid path', 400)
        return
      }

      const absPath = relPath ? resolve(WORKSPACE, relPath) : WORKSPACE
      if (!absPath.startsWith(WORKSPACE)) {
        fail(res, 'Access denied', 403)
        return
      }

      if (!existsSync(absPath)) {
        fail(res, 'Path not found', 404)
        return
      }

      const stat = statSync(absPath)
      if (!stat.isDirectory()) {
        fail(res, 'Not a directory', 400)
        return
      }

      const entries = readdirSync(absPath, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.'))
        .map(e => {
          const entryPath = resolve(absPath, e.name)
          const entryStat = statSync(entryPath)
          return {
            name: e.name,
            type: e.isDirectory() ? 'directory' : 'file',
            size: e.isDirectory() ? undefined : entryStat.size,
            modifiedAt: entryStat.mtime.toISOString(),
          }
        })
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })

      ok(res, { path: relPath || '/', entries })
      return
    }

    // ── PUT /files/* — write/update workspace files ──
    if (url.pathname.startsWith('/files/') && method === 'PUT') {
      const relPath = decodeURIComponent(url.pathname.slice('/files/'.length))

      if (relPath.includes('..') || relPath.startsWith('/')) {
        fail(res, 'Invalid path', 400)
        return
      }

      const absPath = resolve(WORKSPACE, relPath)
      if (!absPath.startsWith(WORKSPACE)) {
        fail(res, 'Access denied', 403)
        return
      }

      // Ensure parent directory exists
      const parentDir = resolve(absPath, '..')
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true })
      }

      const body = await readBody(req)
      writeFileSync(absPath, body, 'utf-8')

      ok(res, { path: relPath, size: Buffer.byteLength(body, 'utf-8') })
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
    log.error('request error', { error: err.message, stack: err.stack })
    fail(res, err.message ?? 'internal error', 500)
  }
})

server.listen(PORT, '0.0.0.0', () => {
  log.info('meios gateway running', {
    url: `http://0.0.0.0:${PORT}`,
    model: `${model.name} (${model.id})`,
    workspace: WORKSPACE,
    version: VERSION,
  })

  // Start JuiceFS-touching init in next tick (non-blocking)
  setImmediate(deferredInit)
})
