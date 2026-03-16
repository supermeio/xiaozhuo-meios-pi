import { Daytona, Image } from '@daytonaio/sdk'
import { getSandboxByUserId, updateSignedUrl, upsertSandbox, type Sandbox } from './db.js'
import { ensureUserPlan } from './billing.js'
import { config } from './config.js'
import { log, logError } from './log.js'
import { createMachine, startMachine, getMachine, checkHealth } from './flyio.js'

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

/**
 * Create a LiteLLM virtual key for a sandbox.
 * The key has per-key rate limiting and monthly budget.
 */
async function createLiteLLMKey(userId: string): Promise<{ key: string; keyName: string }> {
  const resp = await fetch(`${config.litellm.proxyUrl}/key/generate`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.litellm.masterKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // Rate limit: 60 requests per minute
      rpm_limit: 60,
      // Monthly budget: $5 for free tier (500 cents)
      max_budget: 5,
      budget_duration: '30d',
      // Allow all configured models
      models: [],  // empty = allow all models in config
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

/**
 * Delete a LiteLLM virtual key (on sandbox teardown).
 */
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

// ── Signed URL management ──

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

async function refreshSignedUrl(sandbox: Sandbox): Promise<string> {
  const daytona = getDaytona()
  const sb = await daytona.get(sandbox.daytona_id)
  const result = await sb.getSignedPreviewUrl(sandbox.port, SIGNED_URL_TTL)

  const signedUrl = typeof result === 'string' ? result : result.url
  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL * 1000).toISOString()

  await updateSignedUrl(sandbox.user_id, signedUrl, expiresAt)
  return signedUrl
}

// ── Sandbox provisioning ──

/**
 * Provision a new Daytona sandbox for a user.
 *
 * 1. Create LiteLLM virtual key (rate limit + budget)
 * 2. Create sandbox with node:20-slim
 * 3. Clone meios repo & install deps
 * 4. Start the gateway process
 * 5. Get signed preview URL
 * 6. Store sandbox record in DB
 */
export async function provisionSandbox(userId: string): Promise<{ sandbox: Sandbox; signedUrl: string }> {
  const daytona = getDaytona()
  const port = config.meios.gatewayPort

  slog(`provisioning sandbox for user ${userId}...`)

  // 1. Create LiteLLM virtual key — handles rate limiting, budget, usage tracking
  const { key: virtualKey, keyName } = await createLiteLLMKey(userId)
  slog('LiteLLM virtual key created', { keyName })

  // 2. Create sandbox — no real API keys enter the sandbox
  //    All LLM calls go: sandbox → Edge Function → LiteLLM → provider
  const proxyUrl = config.meios.llmProxyUrl
  const sb = await daytona.create({
    image: Image.base('node:20-slim'),
    language: 'typescript',
    resources: { cpu: 2, memory: 2, disk: 5 },
    labels: { app: 'meios', version: '0.1.0' },
    autoStopInterval: 0,
    autoArchiveInterval: 10080, // 7 days
    envVars: {
      // User identity
      MEIOS_USER_ID: userId,
      // All providers use OpenAI-compatible format via LiteLLM.
      // The sandbox sends requests to the Edge Function, which relays to LiteLLM.
      // LiteLLM routes to the correct provider based on model name.
      OPENAI_BASE_URL: proxyUrl,
      OPENAI_API_KEY: virtualKey,
      // Keep Anthropic env for backwards compat (pi-ai may read these)
      ANTHROPIC_BASE_URL: proxyUrl,
      ANTHROPIC_API_KEY: virtualKey,
      // All providers share the same proxy token
      GEMINI_BASE_URL: proxyUrl + '/google/v1beta',
      GEMINI_API_KEY: virtualKey,
      GOOGLE_API_KEY: virtualKey,
      KIMI_BASE_URL: proxyUrl + '/moonshot',
      KIMI_API_KEY: virtualKey,
      // R2 file sync (optional — sync disabled if not set)
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

  // 3. Clone repo & install
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

  // 3b. Write persistent .env.token — server reads this on startup
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

  // 4. Start gateway in background session
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

  // 5. Get signed URL
  const result = await sb.getSignedPreviewUrl(port, SIGNED_URL_TTL)
  const signedUrl = typeof result === 'string' ? result : result.url
  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL * 1000).toISOString()

  // 6. Store in DB (keyName stored for LiteLLM key management)
  const sandbox = await upsertSandbox({
    user_id: userId,
    daytona_id: sb.id,
    signed_url: signedUrl,
    signed_url_exp: expiresAt,
    port,
    token: keyName,          // LiteLLM key name (for revocation)
    token_expires_at: null,  // LiteLLM manages key lifecycle
    status: 'active',
  })

  // Assign free plan if user doesn't have one yet
  await ensureUserPlan(userId)

  slog(`sandbox provisioned for user ${userId}: ${sb.id}`)
  return { sandbox, signedUrl }
}

/**
 * Create an SSH access token for the user's sandbox.
 * Token format: ssh <token>@ssh.app.daytona.io
 */
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

/**
 * Force-refresh a signed URL (e.g., after a 401 from the sandbox).
 */
export async function forceRefreshSignedUrl(userId: string): Promise<string | null> {
  const sandbox = await getSandboxByUserId(userId)
  if (!sandbox) return null

  // Fly.io machines use private IP — no signed URL refresh needed
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
 * 2. Create Fly Machine with JuiceFS + LLM env vars
 * 3. Wait for gateway to be healthy
 * 4. Store sandbox record in DB
 */
export async function provisionFlyMachine(userId: string): Promise<{ sandbox: Sandbox; signedUrl: string }> {
  const port = config.meios.gatewayPort
  slog(`provisioning Fly.io machine for user ${userId}...`)

  // 1. Create LiteLLM virtual key
  const { key: virtualKey, keyName } = await createLiteLLMKey(userId)
  slog('LiteLLM virtual key created', { keyName })

  // 2. Create Fly Machine
  const proxyUrl = config.meios.llmProxyUrl
  const { machineId, privateIp } = await createMachine({
    userId,
    llmProxyUrl: proxyUrl,
    virtualKey,
  })

  slog(`Fly machine created: ${machineId}`, { privateIp })

  // 3. Wait for gateway to be healthy (poll for up to 60s)
  let healthy = false
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000))
    healthy = await checkHealth(privateIp, port)
    if (healthy) {
      slog(`health check passed on attempt ${i + 1}`)
      break
    }
  }

  if (!healthy) {
    slog('health check did not pass after 20 attempts')
  }

  // 4. Build sandbox URL — Fly machines are accessed via private IPv6
  // The gateway proxy will forward requests to this address
  const sandboxUrl = `http://[${privateIp}]:${port}`

  // 5. Store in DB (reuse Sandbox table — daytona_id stores fly machine ID)
  const sandbox = await upsertSandbox({
    user_id: userId,
    daytona_id: machineId,       // Fly machine ID (reusing daytona_id column)
    signed_url: sandboxUrl,       // Private IP URL (reusing signed_url column)
    signed_url_exp: null,         // No expiry for Fly private IPs
    port,
    token: keyName,
    token_expires_at: null,
    status: 'active',
  })

  await ensureUserPlan(userId)

  slog(`Fly machine provisioned for user ${userId}: ${machineId}`)
  return { sandbox, signedUrl: sandboxUrl }
}

/**
 * Resolve sandbox URL for a user — works for both Daytona and Fly.io.
 *
 * For Fly.io: checks if machine is running, starts it if stopped.
 * For Daytona: delegates to resolveSignedUrl (existing behavior).
 */
export async function resolveSandboxUrl(userId: string): Promise<string | null> {
  if (config.sandboxProvider !== 'flyio') {
    return resolveSignedUrl(userId)
  }

  const sandbox = await getSandboxByUserId(userId)
  if (!sandbox) return null

  // Check if machine is still running
  const machine = await getMachine(sandbox.daytona_id)
  if (!machine) return null

  if (machine.state === 'stopped' || machine.state === 'suspended') {
    // Start the stopped machine (resume on demand)
    slog('starting stopped Fly machine', { machineId: sandbox.daytona_id, userId })
    await startMachine(sandbox.daytona_id)

    // Wait for health
    const port = sandbox.port ?? config.meios.gatewayPort
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000))
      if (await checkHealth(machine.private_ip, port)) break
    }
  }

  return sandbox.signed_url
}
