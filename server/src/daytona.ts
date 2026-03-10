#!/usr/bin/env node
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
  console.log(`[state] saved to ${STATE_FILE}`)
}

function loadState(): Record<string, any> | null {
  if (!existsSync(STATE_FILE)) return null
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
}

function log(msg: string) { console.log(`[daytona] ${msg}`) }

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

  log('creating sandbox with node:20-slim image...')
  const sandbox = await daytona.create({
    image: Image.base('node:20-slim'),
    language: 'typescript',
    resources: { cpu: 2, memory: 2, disk: 5 },
    labels: LABEL,
    autoStopInterval: 0,  // disable auto-stop for POC
    autoArchiveInterval: 10080,  // 7 days
    envVars: {
      ANTHROPIC_API_KEY: anthropicKey,
    },
  }, {
    timeout: 120,
    onSnapshotCreateLogs: (chunk) => process.stdout.write(chunk),
  })

  log(`sandbox created: ${sandbox.id} (state: ${sandbox.state})`)
  log(`  cpu: ${sandbox.cpu}, memory: ${sandbox.memory}GB, disk: ${sandbox.disk}GB`)

  // Upload source files
  log('uploading source files...')
  const files = getSourceFiles()
  await sandbox.fs.uploadFiles(files)
  log(`uploaded ${files.length} files`)

  // Also upload auth.json
  await sandbox.fs.uploadFile(
    readFileSync(authPath),
    '/home/daytona/meios/.meios-agent/auth.json',
  )
  log('uploaded auth.json')

  // Install dependencies
  log('installing dependencies (npm install)...')
  const installResult = await sandbox.process.executeCommand(
    'cd /home/daytona/meios && npm install --production 2>&1',
    undefined,
    undefined,
    300, // 5 min timeout
  )
  if (installResult.exitCode !== 0) {
    console.error('npm install failed:', installResult.result)
    throw new Error('npm install failed')
  }
  log(`npm install done (exit ${installResult.exitCode})`)

  // Start gateway in a background session
  log('starting gateway...')
  await sandbox.process.createSession('gateway')
  const startResult = await sandbox.process.executeSessionCommand('gateway', {
    command: 'cd /home/daytona/meios && node --import tsx src/gateway.ts 2>&1',
    runAsync: true,
  })
  log(`gateway session started (cmdId: ${startResult.cmdId})`)

  // Wait a moment then verify
  await new Promise(r => setTimeout(r, 5000))

  const healthCheck = await sandbox.process.executeCommand(
    'curl -s http://localhost:18800/health',
  )
  log(`health check: ${healthCheck.result}`)

  // Get preview link
  try {
    const preview = await sandbox.getPreviewLink(18800)
    log(`preview URL: ${preview.url}`)
    saveState({
      sandboxId: sandbox.id,
      sandboxName: sandbox.name,
      previewUrl: preview.url,
      previewToken: preview.token,
      createdAt: new Date().toISOString(),
    })
  } catch (e: any) {
    log(`preview link not available: ${e.message}`)
    saveState({
      sandboxId: sandbox.id,
      sandboxName: sandbox.name,
      createdAt: new Date().toISOString(),
    })
  }

  // SSH access
  try {
    const ssh = await sandbox.createSshAccess(60 * 24) // 24 hour token
    log(`SSH: ssh ${ssh.token}@ssh.app.daytona.io`)
  } catch (e: any) {
    log(`SSH access: ${e.message}`)
  }

  log('deployment complete!')
}

async function status() {
  const state = loadState()
  if (!state) { log('no sandbox found. Run: create'); return }

  const daytona = new Daytona()
  try {
    const sandbox = await daytona.get(state.sandboxId)
    log(`sandbox: ${sandbox.id}`)
    log(`  name: ${sandbox.name}`)
    log(`  state: ${sandbox.state}`)
    log(`  cpu: ${sandbox.cpu}, memory: ${sandbox.memory}GB, disk: ${sandbox.disk}GB`)
    log(`  created: ${sandbox.createdAt}`)

    if (sandbox.state === 'started') {
      const health = await sandbox.process.executeCommand('curl -s http://localhost:18800/health')
      log(`  health: ${health.result}`)
    }
  } catch (e: any) {
    log(`error: ${e.message}`)
  }
}

async function destroy() {
  const state = loadState()
  if (!state) { log('no sandbox found'); return }

  const daytona = new Daytona()
  const sandbox = await daytona.get(state.sandboxId)
  log(`deleting sandbox ${sandbox.id}...`)
  await sandbox.delete()
  writeFileSync(STATE_FILE, '{}')
  log('sandbox deleted')
}

// ── CLI ──
const cmd = process.argv[2] ?? 'create'
switch (cmd) {
  case 'create': await createSandbox(); break
  case 'status': await status(); break
  case 'destroy': await destroy(); break
  default: console.log('Usage: daytona.ts [create|status|destroy]')
}
