#!/usr/bin/env node
/**
 * meios — lightweight vertical agent powered by pi-mono
 *
 * Usage:
 *   One-shot:    node --import tsx src/index.ts --message "你好"
 *   Interactive: node --import tsx src/index.ts
 */

import { logger } from './log.js'
import { createAgentSession, codingTools, type AgentSessionEvent } from '@mariozechner/pi-coding-agent'

const log = logger.getSubLogger({ name: 'server' })
import { getModel } from '@mariozechner/pi-ai'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { wardrobeTools, setWorkspaceRoot } from './tools.js'

// ── Config ──
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..')
const WORKSPACE = resolve(PROJECT_ROOT, 'workspace')
const AGENT_DIR = resolve(PROJECT_ROOT, '.meios-agent')
mkdirSync(AGENT_DIR, { recursive: true })
setWorkspaceRoot(WORKSPACE)

// ── Load system prompt from SOUL.md + MEMORY.md ──
function loadSystemPrompt(): string {
  const parts: string[] = []
  const soulPath = resolve(WORKSPACE, 'SOUL.md')
  const memoryPath = resolve(WORKSPACE, 'MEMORY.md')
  if (existsSync(soulPath)) parts.push(readFileSync(soulPath, 'utf-8'))
  if (existsSync(memoryPath)) parts.push('---\n\n# 用户记忆\n\n' + readFileSync(memoryPath, 'utf-8'))
  return parts.join('\n\n')
}

// ── Parse CLI args ──
function parseArgs() {
  const args = process.argv.slice(2)
  const msgIdx = args.indexOf('--message')
  if (msgIdx !== -1 && args[msgIdx + 1]) {
    return { mode: 'oneshot' as const, message: args[msgIdx + 1] }
  }
  return { mode: 'interactive' as const, message: '' }
}

// ── Main ──
async function main() {
  const { mode, message } = parseArgs()

  log.info('starting', { workspace: WORKSPACE })

  // Load .env.token (source of truth — overrides stale Daytona env vars)
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

  // Load auth.json (legacy)
  const authPath = resolve(AGENT_DIR, 'auth.json')
  if (existsSync(authPath)) {
    const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
    if (auth.anthropic?.token && !process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = auth.anthropic.token
    }
  }

  // Env normalization — derive missing keys from the surviving one
  const proxyToken = process.env.ANTHROPIC_API_KEY
  if (proxyToken) {
    if (!process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = proxyToken
    if (!process.env.GOOGLE_API_KEY) process.env.GOOGLE_API_KEY = proxyToken
    if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = proxyToken
    if (!process.env.KIMI_API_KEY) process.env.KIMI_API_KEY = proxyToken
  }
  const proxyBase = process.env.ANTHROPIC_BASE_URL
  if (proxyBase) {
    if (!process.env.GEMINI_BASE_URL) process.env.GEMINI_BASE_URL = proxyBase + '/google/v1beta'
    if (!process.env.OPENAI_BASE_URL) process.env.OPENAI_BASE_URL = proxyBase + '/openai/v1'
    if (!process.env.KIMI_BASE_URL) process.env.KIMI_BASE_URL = proxyBase + '/moonshot'
  }

  const model = getModel('google', 'gemini-3.1-flash-lite-preview')

  // Override base URLs to route through LLM proxy
  if (process.env.ANTHROPIC_BASE_URL) {
    const anthropicModel = getModel('anthropic', 'claude-haiku-4-5')
    if (anthropicModel) (anthropicModel as any).baseUrl = process.env.ANTHROPIC_BASE_URL
  }
  if (process.env.GEMINI_BASE_URL) {
    ;(model as any).baseUrl = process.env.GEMINI_BASE_URL
  }

  // Note: env vars kept — pi-ai reads keys lazily at prompt() time.
  // In sandbox, these are proxy tokens, not real API keys.

  log.info('model loaded', { model: model.name, id: model.id })

  const { session } = await createAgentSession({
    cwd: WORKSPACE,
    agentDir: AGENT_DIR,
    model,
    tools: codingTools,  // read, bash, edit, write — 自我维修能力,
    customTools: wardrobeTools,
    thinkingLevel: 'minimal',
  })

  // Set system prompt on the agent (PromptOptions doesn't accept systemPrompt)
  session.agent.setSystemPrompt(loadSystemPrompt())

  // ── Run a prompt, collect text via events ──
  async function chat(input: string): Promise<string> {
    return new Promise<string>((resolveText) => {
      const textChunks: string[] = []

      const unsub = session.subscribe((event: AgentSessionEvent) => {
        // Collect only text deltas (skip thinking)
        if (event.type === 'message_update') {
          const evt = (event as any).assistantMessageEvent
          if (evt?.type === 'text_delta' && evt.delta) {
            textChunks.push(evt.delta)
          }
        }

        // On agent_end, resolve with collected text
        if (event.type === 'agent_end') {
          unsub()
          if (textChunks.length > 0) {
            resolveText(textChunks.join(''))
          } else {
            // Fallback: extract from final messages
            const text = ((event as any).messages ?? [])
              .flatMap((m: any) => m.content ?? [])
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('')
            resolveText(text || '[无回复]')
          }
        }
      })

      session.prompt(input, { images: [] })
    })
  }

  // ── One-shot mode ──
  if (mode === 'oneshot') {
    console.log(`你> ${message}\n`)
    const reply = await chat(message)
    console.log(`小周> ${reply}`)
    return
  }

  // ── Interactive REPL ──
  console.log('🧥 meios ready! Type your message (Ctrl+C to quit)')
  console.log('─'.repeat(50))

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n你> ',
    terminal: process.stdin.isTTY ?? false,
  })

  rl.prompt()

  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) { rl.prompt(); return }
    try {
      const reply = await chat(input)
      console.log(`\n小周> ${reply}`)
    } catch (err: any) {
      log.error('chat error', { error: err.message ?? String(err) })
    }
    rl.prompt()
  })

  rl.on('close', () => {
    console.log('\n👋 bye!')
    process.exit(0)
  })
}

main().catch((err) => {
  log.fatal('fatal error', { error: err.message ?? String(err), stack: err.stack })
  process.exit(1)
})
