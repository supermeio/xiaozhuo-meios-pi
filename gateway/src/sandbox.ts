import { randomBytes, createHash } from 'node:crypto'
import { Daytona, Image } from '@daytonaio/sdk'
import { getSandboxByUserId, updateSignedUrl, upsertSandbox, type Sandbox } from './db.js'
import { config } from './config.js'
import { log } from './log.js'

const SIGNED_URL_TTL = 86400 // 24 hours
const REFRESH_BUFFER = 3600  // refresh 1 hour before expiry

let _daytona: Daytona | null = null

function getDaytona(): Daytona {
  if (!_daytona) {
    _daytona = new Daytona()
  }
  return _daytona
}

function slog(msg: string, data?: Record<string, unknown>) { log('sandbox', msg, data) }

/**
 * Resolve the signed preview URL for a user's sandbox.
 * Refreshes automatically if expired or about to expire.
 */
export async function resolveSignedUrl(userId: string): Promise<string | null> {
  const sandbox = await getSandboxByUserId(userId)
  if (!sandbox) return null

  // Check if signed URL is still valid (with buffer)
  if (sandbox.signed_url && sandbox.signed_url_exp) {
    const expiresAt = new Date(sandbox.signed_url_exp).getTime()
    const now = Date.now()
    if (now < expiresAt - REFRESH_BUFFER * 1000) {
      return sandbox.signed_url
    }
  }

  // Refresh signed URL
  return await refreshSignedUrl(sandbox)
}

/**
 * Refresh the signed preview URL for a sandbox.
 */
async function refreshSignedUrl(sandbox: Sandbox): Promise<string> {
  const daytona = getDaytona()
  const sb = await daytona.get(sandbox.daytona_id)
  const result = await sb.getSignedPreviewUrl(sandbox.port, SIGNED_URL_TTL)

  const signedUrl = typeof result === 'string' ? result : result.url
  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL * 1000).toISOString()

  await updateSignedUrl(sandbox.user_id, signedUrl, expiresAt)
  return signedUrl
}

/**
 * Provision a new Daytona sandbox for a user.
 *
 * 1. Create sandbox with node:20-slim
 * 2. Clone meios repo & install deps
 * 3. Start the gateway process
 * 4. Get signed preview URL
 * 5. Store sandbox record in DB
 */
export async function provisionSandbox(userId: string): Promise<{ sandbox: Sandbox; signedUrl: string }> {
  const daytona = getDaytona()
  const port = config.meios.gatewayPort

  slog(`provisioning sandbox for user ${userId}...`)

  // Generate a per-sandbox token for LLM proxy auth (hash before storing)
  const sandboxToken = `sbx_${randomBytes(32).toString('hex')}`
  const hashedToken = createHash('sha256').update(sandboxToken).digest('hex')

  // 1. Create sandbox — real API key never enters the sandbox
  const sb = await daytona.create({
    image: Image.base('node:20-slim'),
    language: 'typescript',
    resources: { cpu: 2, memory: 2, disk: 5 },
    labels: { app: 'meios', version: '0.1.0' },
    autoStopInterval: 0,
    autoArchiveInterval: 10080, // 7 days
    envVars: {
      ANTHROPIC_BASE_URL: config.meios.llmProxyUrl,
      ANTHROPIC_API_KEY: sandboxToken,
    },
  }, {
    timeout: 120,
  })

  slog(`sandbox created: ${sb.id}`)

  // 2. Clone repo & install
  slog('cloning meios repo and installing deps...')
  const setupCmd = [
    'apt-get update -qq && apt-get install -y -qq git > /dev/null 2>&1',
    `git clone --depth 1 ${config.meios.repoUrl} /home/daytona/meios`,
    'cd /home/daytona/meios/server && npm install --production 2>&1',
  ].join(' && ')

  const installResult = await sb.process.executeCommand(setupCmd, undefined, undefined, 300)
  if (installResult.exitCode !== 0) {
    slog(`setup failed: ${installResult.result}`)
    throw new Error(`Sandbox setup failed: ${installResult.result.slice(0, 200)}`)
  }
  slog('deps installed')

  // 3. Start gateway in background session
  slog('starting gateway...')
  await sb.process.createSession('gateway')
  await sb.process.executeSessionCommand('gateway', {
    command: `cd /home/daytona/meios/server && node --import tsx src/gateway.ts 2>&1`,
    runAsync: true,
  })

  // Poll health until ready (max 30 seconds)
  const HEALTH_CMD = `node -e "const h=require('http');h.get('http://localhost:${port}/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))}).on('error',e=>console.error(e.message))"`
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000))
    const health = await sb.process.executeCommand(HEALTH_CMD)
    if (health.exitCode === 0 && health.result.includes('"ok":true')) {
      slog(`health check passed on attempt ${i + 1}`)
      break
    }
    if (i === 14) {
      slog(`health check did not pass after 15 attempts: ${health.result}`)
    }
  }

  // 4. Get signed URL
  const result = await sb.getSignedPreviewUrl(port, SIGNED_URL_TTL)
  const signedUrl = typeof result === 'string' ? result : result.url
  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL * 1000).toISOString()

  // 5. Store in DB (including sandbox token for LLM proxy auth)
  const sandbox = await upsertSandbox({
    user_id: userId,
    daytona_id: sb.id,
    signed_url: signedUrl,
    signed_url_exp: expiresAt,
    port,
    token: hashedToken,
    token_expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
    status: 'active',
  })

  slog(`sandbox provisioned for user ${userId}: ${sb.id}`)
  return { sandbox, signedUrl }
}

/**
 * Force-refresh a signed URL (e.g., after a 401 from the sandbox).
 */
export async function forceRefreshSignedUrl(userId: string): Promise<string | null> {
  const sandbox = await getSandboxByUserId(userId)
  if (!sandbox) return null
  return await refreshSignedUrl(sandbox)
}
