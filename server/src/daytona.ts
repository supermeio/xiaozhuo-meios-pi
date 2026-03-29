#!/usr/bin/env node
// ⚠️  POC ONLY — Do NOT use in production.
// This script injects the real ANTHROPIC_API_KEY into sandboxes.
// Production flow uses gateway/src/sandbox.ts which injects a per-sandbox
// token (sbx_...) and routes through the LLM proxy instead.
/**
 * Daytona deployment POC — create a sandbox, deploy meios, verify it works.
 *
 * Usage:
 *   node --import tsx src/daytona.ts create     # Create & deploy
 *   node --import tsx src/daytona.ts status      # Check sandbox status
 *   node --import tsx src/daytona.ts destroy     # Delete sandbox
 */

import { Daytona, Image } from '@daytonaio/sdk'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { logger } from './log.js'

const log = logger.getSubLogger({ name: 'daytona' })

// ── Config ──
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..')
const STATE_FILE = resolve(PROJECT_ROOT, '.meios-agent', 'daytona-sandbox.json')
const LABEL = { app: 'meios', version: '0.1.0' }

// Load env
const envPath = resolve(PROJECT_ROOT, '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^(\w+)=(.*)$/)
    if (match) process.env[match[1]] = match[2]
  }
}

// Anthropic key for the agent inside sandbox
const authPath = resolve(PROJECT_ROOT, '.meios-agent', 'auth.json')
const anthropicKey = existsSync(authPath)
  ? JSON.parse(readFileSync(authPath, 'utf-8')).anthropic?.token
  : process.env.ANTHROPIC_API_KEY

if (!anthropicKey) throw new Error('No ANTHROPIC_API_KEY found')

// ── Helpers ──
function saveState(state: Record<string, any>) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  log.info('state saved', { path: STATE_FILE })
}

function loadState(): Record<string, any> | null {
  if (!existsSync(STATE_FILE)) return null
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
}

// logger sub-logger `log` defined at top of file

// ── Source files to upload ──
function getSourceFiles(): Array<{ source: Buffer; destination: string }> {
  const files = [
    'package.json',
    'src/index.ts',
    'src/gateway.ts',
    'src/tools.ts',
    'src/cron.ts',
    'src/heartbeat.ts',
    'workspace/SOUL.md',
    'workspace/MEMORY.md',
  ]

  return files
    .filter(f => existsSync(resolve(PROJECT_ROOT, f)))
    .map(f => ({
      source: readFileSync(resolve(PROJECT_ROOT, f)),
      destination: `/home/daytona/meios/${f}`,
    }))
}

// ── Commands ──

async function createSandbox() {
  const daytona = new Daytona()

  log.info('creating sandbox with node:20-slim image...')
  const sandbox = await daytona.create({
    image: Image.base('node:20-slim'),
    language: 'typescript',
    resources: { cpu: 2, memory: 2, disk: 5 },
    labels: LABEL,
    autoStopInterval: 0,  // disable auto-stop for POC
    autoArchiveInterval: 10080,  // 7 days
    // NOTE: This POC injects the key directly. In production, the gateway's
    // provisionSandbox() uses a per-sandbox sbx_ token + LLM proxy instead.
    // To test with the proxy, set ANTHROPIC_BASE_URL to your Edge Function URL
    // and use a sandbox token as ANTHROPIC_API_KEY.
    envVars: {
      ANTHROPIC_API_KEY: anthropicKey,
    },
  }, {
    timeout: 120,
    onSnapshotCreateLogs: (chunk) => process.stdout.write(chunk),
  })

  log.info('sandbox created', { id: sandbox.id, state: sandbox.state, cpu: sandbox.cpu, memory: sandbox.memory, disk: sandbox.disk })

  // Upload source files
  log.info('uploading source files...')
  const files = getSourceFiles()
  await sandbox.fs.uploadFiles(files)
  log.info('uploaded files', { count: files.length })

  // Also upload auth.json
  await sandbox.fs.uploadFile(
    readFileSync(authPath),
    '/home/daytona/meios/.meios-agent/auth.json',
  )
  log.info('uploaded auth.json')

  // Install dependencies
  log.info('installing dependencies (npm install)...')
  const installResult = await sandbox.process.executeCommand(
    'cd /home/daytona/meios && npm install --production 2>&1',
    undefined,
    undefined,
    300, // 5 min timeout
  )
  if (installResult.exitCode !== 0) {
    log.error('npm install failed', { output: installResult.result })
    throw new Error('npm install failed')
  }
  log.info('npm install done', { exitCode: installResult.exitCode })

  // Start gateway in a background session
  log.info('starting gateway...')
  await sandbox.process.createSession('gateway')
  const startResult = await sandbox.process.executeSessionCommand('gateway', {
    command: 'cd /home/daytona/meios && node --import tsx src/gateway.ts 2>&1',
    runAsync: true,
  })
  log.info('gateway session started', { cmdId: startResult.cmdId })

  // Wait a moment then verify
  await new Promise(r => setTimeout(r, 5000))

  const healthCheck = await sandbox.process.executeCommand(
    'curl -s http://localhost:18800/health',
  )
  log.info('health check', { result: healthCheck.result })

  // Get preview link
  try {
    const preview = await sandbox.getPreviewLink(18800)
    log.info('preview URL', { url: preview.url })
    saveState({
      sandboxId: sandbox.id,
      sandboxName: sandbox.name,
      previewUrl: preview.url,
      previewToken: preview.token,
      createdAt: new Date().toISOString(),
    })
  } catch (e: any) {
    log.warn('preview link not available', { error: e.message })
    saveState({
      sandboxId: sandbox.id,
      sandboxName: sandbox.name,
      createdAt: new Date().toISOString(),
    })
  }

  // SSH access
  try {
    const ssh = await sandbox.createSshAccess(60 * 24) // 24 hour token
    log.info('SSH access', { command: `ssh ${ssh.token}@ssh.app.daytona.io` })
  } catch (e: any) {
    log.warn('SSH access not available', { error: e.message })
  }

  log.info('deployment complete!')
}

async function status() {
  const state = loadState()
  if (!state) { log.info('no sandbox found. Run: create'); return }

  const daytona = new Daytona()
  try {
    const sandbox = await daytona.get(state.sandboxId)
    log.info('sandbox status', {
      id: sandbox.id, name: sandbox.name, state: sandbox.state,
      cpu: sandbox.cpu, memory: sandbox.memory, disk: sandbox.disk,
      created: sandbox.createdAt,
    })

    if (sandbox.state === 'started') {
      const health = await sandbox.process.executeCommand('curl -s http://localhost:18800/health')
      log.info('health check', { result: health.result })
    }
  } catch (e: any) {
    log.error('status check failed', { error: e.message })
  }
}

async function destroy() {
  const state = loadState()
  if (!state) { log.info('no sandbox found'); return }

  const daytona = new Daytona()
  const sandbox = await daytona.get(state.sandboxId)
  log.info('deleting sandbox', { id: sandbox.id })
  await sandbox.delete()
  writeFileSync(STATE_FILE, '{}')
  log.info('sandbox deleted')
}

// ── CLI ──
const cmd = process.argv[2] ?? 'create'
switch (cmd) {
  case 'create': await createSandbox(); break
  case 'status': await status(); break
  case 'destroy': await destroy(); break
  default: log.info('Usage: daytona.ts [create|status|destroy]')
}
