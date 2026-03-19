import { Daytona, Image } from '@daytonaio/sdk'
import { getSandboxByUserId, updateSignedUrl, upsertSandbox, type Sandbox } from './db.js'
import { ensureUserPlan } from './billing.js'
import { config } from './config.js'
import { log, logError } from './log.js'
import { createMachine, startMachine, getMachine, checkHealth, flyProxyUrl } from './flyio.js'

const SIGNED_URL_TTL = 86400    // 24 hours
const REFRESH_BUFFER = 3600     // refresh 1 hour before expiry

let _daytona: Daytona | null = null

function getDaytona(): Daytona {
  if (!_daytona) {
    _daytona = new Daytona()
  }
  return _daytona
}

function slog(msg: string, data?: Record<string, unknown>) { log('sandbox', msg, data) }

// ── LiteLLM virtual key management ──

async function createLiteLLMKey(userId: string): Promise<{ key: string; keyName: string }> {
  const resp = await fetch(`${config.litellm.proxyUrl}/key/generate`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.litellm.masterKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      rpm_limit: 60,
      max_budget: 5,
      budget_duration: '30d',
      models: [],
      metadata: { user_id: userId, app: 'meios' },
    }),
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`LiteLLM key/generate failed (${resp.status}): ${body}`)
  }

  const data = await resp.json()
  return { key: data.key, keyName: data.key_name ?? data.key }
}

export async function deleteLiteLLMKey(keyName: string): Promise<void> {
  try {
    await fetch(`${config.litellm.proxyUrl}/key/delete`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.litellm.masterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ keys: [keyName] }),
    })
  } catch (err) {
    logError('sandbox', 'failed to delete LiteLLM key', err as Error, { keyName })
  }
}

// ── Signed URL management (Daytona only) ──

export async function resolveSignedUrl(userId: string): Promise<string | null> {
  const sandbox = await getSandboxByUserId(userId)
  if (!sandbox) return null

  if (sandbox.signed_url && sandbox.signed_url_exp) {
    const expiresAt = new Date(sandbox.signed_url_exp).getTime()
    const now = Date.now()
    if (now < expiresAt - REFRESH_BUFFER * 1000) {
      return sandbox.signed_url
    }
  }

  return await refreshSignedUrl(sandbox)
}

async function refreshSignedUrl(sandbox: Sandbox): Promise<string> {
  const daytona = getDaytona()
  const sb = await daytona.get(sandbox.daytona_id)
  const result = await sb.getSignedPreviewUrl(sandbox.port, SIGNED_URL_TTL)

  const signedUrl = typeof result === 'string' ? result : result.url
  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL * 1000).toISOString()

  await updateSignedUrl(sandbox.user_id, signedUrl, expiresAt)
  return signedUrl
}

// ── Daytona provisioning ──

export async function provisionSandbox(userId: string): Promise<{ sandbox: Sandbox; signedUrl: string }> {
  const daytona = getDaytona()
  const port = config.meios.gatewayPort

  slog(`provisioning sandbox for user ${userId}...`)

  const { key: virtualKey, keyName } = await createLiteLLMKey(userId)
  slog('LiteLLM virtual key created', { keyName })

  const proxyUrl = config.meios.llmProxyUrl
  const sb = await daytona.create({
    image: Image.base('node:20-slim'),
    language: 'typescript',
    resources: { cpu: 2, memory: 2, disk: 5 },
    labels: { app: 'meios', version: '0.1.0' },
    autoStopInterval: 0,
    autoArchiveInterval: 10080,
    envVars: {
      MEIOS_USER_ID: userId,
      OPENAI_BASE_URL: proxyUrl,
      OPENAI_API_KEY: virtualKey,
      ANTHROPIC_BASE_URL: proxyUrl,
      ANTHROPIC_API_KEY: virtualKey,
      GEMINI_BASE_URL: proxyUrl + '/google/v1beta',
      GEMINI_API_KEY: virtualKey,
      GOOGLE_API_KEY: virtualKey,
      KIMI_BASE_URL: proxyUrl + '/moonshot',
      KIMI_API_KEY: virtualKey,
      ...(config.r2?.endpoint ? {
        R2_ENDPOINT: config.r2.endpoint,
        R2_ACCESS_KEY_ID: config.r2.accessKeyId,
        R2_SECRET_ACCESS_KEY: config.r2.secretAccessKey,
        R2_BUCKET: config.r2.bucket ?? 'meios-images',
        R2_PUBLIC_URL: config.r2.publicUrl ?? '',
      } : {}),
    },
  }, {
    timeout: 120,
  })

  slog(`sandbox created: ${sb.id}`)

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

  const envTokenLines = [
    `MEIOS_USER_ID=${userId}`,
    `OPENAI_BASE_URL=${proxyUrl}`,
    `OPENAI_API_KEY=${virtualKey}`,
    `ANTHROPIC_BASE_URL=${proxyUrl}`,
    `ANTHROPIC_API_KEY=${virtualKey}`,
    `GEMINI_BASE_URL=${proxyUrl}/google/v1beta`,
    `GEMINI_API_KEY=${virtualKey}`,
    `GOOGLE_API_KEY=${virtualKey}`,
    `KIMI_BASE_URL=${proxyUrl}/moonshot`,
    `KIMI_API_KEY=${virtualKey}`,
    ...(config.r2?.endpoint ? [
      `R2_ENDPOINT=${config.r2.endpoint}`,
      `R2_ACCESS_KEY_ID=${config.r2.accessKeyId}`,
      `R2_SECRET_ACCESS_KEY=${config.r2.secretAccessKey}`,
      `R2_BUCKET=${config.r2.bucket ?? 'meios-images'}`,
      `R2_PUBLIC_URL=${config.r2.publicUrl ?? ''}`,
    ] : []),
  ].join('\n')
  await sb.process.executeCommand(
    `cat > /home/daytona/meios/.env.token << 'EOF'\n${envTokenLines}\nEOF`,
  )
  slog('.env.token written')

  slog('starting gateway...')
  await sb.process.createSession('gateway')
  await sb.process.executeSessionCommand('gateway', {
    command: `cd /home/daytona/meios/server && node --import tsx src/gateway.ts 2>&1`,
    runAsync: true,
  })

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

  const result = await sb.getSignedPreviewUrl(port, SIGNED_URL_TTL)
  const signedUrl = typeof result === 'string' ? result : result.url
  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL * 1000).toISOString()

  const sandbox = await upsertSandbox({
    user_id: userId,
    daytona_id: sb.id,
    signed_url: signedUrl,
    signed_url_exp: expiresAt,
    port,
    token: keyName,
    token_expires_at: null,
    status: 'active',
  })

  await ensureUserPlan(userId)

  slog(`sandbox provisioned for user ${userId}: ${sb.id}`)
  return { sandbox, signedUrl }
}

export async function createSshToken(userId: string, expiresInMinutes = 60): Promise<{ token: string; host: string; command: string } | null> {
  const sandbox = await getSandboxByUserId(userId)
  if (!sandbox) return null

  const daytona = getDaytona()
  const sb = await daytona.get(sandbox.daytona_id)
  const sshAccess = await sb.createSshAccess(expiresInMinutes)

  const token = sshAccess.token
  const host = 'ssh.app.daytona.io'

  slog('SSH token created', { userId, expiresInMinutes })
  return { token, host, command: `ssh ${token}@${host}` }
}

export async function forceRefreshSignedUrl(userId: string): Promise<string | null> {
  const sandbox = await getSandboxByUserId(userId)
  if (!sandbox) return null

  // Fly.io machines use Fly Proxy — no signed URL refresh needed
  if (config.sandboxProvider === 'flyio') {
    return sandbox.signed_url
  }

  return await refreshSignedUrl(sandbox)
}

// ── Fly.io provisioning ──

/**
 * Provision a new Fly.io Machine for a user.
 *
 * 1. Create LiteLLM virtual key (rate limit + budget)
 * 2. Create Fly Machine with services (public via Fly Proxy) + JuiceFS + LLM env vars
 * 3. Wait for gateway to be healthy (via Fly Proxy)
 * 4. Store sandbox record in DB
 */
export async function provisionFlyMachine(userId: string): Promise<{ sandbox: Sandbox; signedUrl: string }> {
  const port = config.meios.gatewayPort
  slog(`provisioning Fly.io machine for user ${userId}...`)

  // 1. Create LiteLLM virtual key
  const { key: virtualKey, keyName } = await createLiteLLMKey(userId)
  slog('LiteLLM virtual key created', { keyName })

  // 2. Create Fly Machine (with services for Fly Proxy access)
  const proxyUrl = config.meios.llmProxyUrl
  const { machineId } = await createMachine({
    userId,
    llmProxyUrl: proxyUrl,
    virtualKey,
  })

  slog(`Fly machine created: ${machineId}`)

  // 3. Wait for gateway to be healthy (via Fly Proxy + fly-force-instance-id)
  let healthy = false
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000))
    healthy = await checkHealth(machineId, port)
    if (healthy) {
      slog(`health check passed on attempt ${i + 1}`)
      break
    }
  }

  if (!healthy) {
    slog('health check did not pass after 20 attempts')
  }

  // 4. Store in DB — URL is the Fly Proxy base, machineId stored in daytona_id
  const sandbox = await upsertSandbox({
    user_id: userId,
    daytona_id: machineId,
    signed_url: flyProxyUrl(),
    signed_url_exp: null,    // No expiry for Fly Proxy
    port,
    token: keyName,
    token_expires_at: null,
    status: 'active',
  })

  await ensureUserPlan(userId)

  slog(`Fly machine provisioned for user ${userId}: ${machineId}`)
  return { sandbox, signedUrl: flyProxyUrl() }
}

/**
 * Resolve sandbox access for a user — works for both Daytona and Fly.io.
 *
 * Returns { url, machineId } where machineId is set for Fly.io (used for routing header).
 */
export async function resolveSandboxUrl(userId: string): Promise<{ url: string; machineId?: string } | null> {
  if (config.sandboxProvider !== 'flyio') {
    const url = await resolveSignedUrl(userId)
    return url ? { url } : null
  }

  const t0 = Date.now()
  const sandbox = await getSandboxByUserId(userId)
  if (!sandbox) return null
  slog('resolve: db lookup', { machineId: sandbox.daytona_id, ms: Date.now() - t0 })

  // Check if machine is still running
  const t1 = Date.now()
  const machine = await getMachine(sandbox.daytona_id)
  if (!machine) {
    slog('resolve: machine not found', { machineId: sandbox.daytona_id, ms: Date.now() - t1 })
    return null
  }
  slog('resolve: getMachine', { machineId: sandbox.daytona_id, state: machine.state, ms: Date.now() - t1 })

  if (machine.state === 'stopped' || machine.state === 'suspended') {
    slog('starting stopped Fly machine', { machineId: sandbox.daytona_id, state: machine.state, userId })
    const t2 = Date.now()
    await startMachine(sandbox.daytona_id)
    slog('resolve: startMachine done', { ms: Date.now() - t2 })

    // Wait for health via Fly Proxy
    const port = sandbox.port ?? config.meios.gatewayPort
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000))
      const healthy = await checkHealth(sandbox.daytona_id, port)
      if (healthy) {
        slog('resolve: health check passed', { attempt: i + 1, totalMs: Date.now() - t0 })
        break
      }
      if (i === 19) slog('resolve: health check failed after 20 attempts', { totalMs: Date.now() - t0 })
    }
  }

  slog('resolve: done', { machineId: sandbox.daytona_id, state: machine.state, totalMs: Date.now() - t0 })
  return { url: flyProxyUrl(), machineId: sandbox.daytona_id }
}
