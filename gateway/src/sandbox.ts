import { getSandboxByUserId, upsertSandbox, type Sandbox } from './db.js'
import { ensureUserPlan } from './billing.js'
import { config } from './config.js'
import { log, logError } from './log.js'
import { createMachine, startMachine, getMachine, checkHealth, flyProxyUrl } from './flyio.js'

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

  // 4. Store in DB — URL is the Fly Proxy base, machineId stored in daytona_id column
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
 * Resolve sandbox access URL for a user.
 *
 * Returns { url, machineId } where machineId is used for the Fly Proxy routing header.
 */
export async function resolveSandboxUrl(userId: string): Promise<{ url: string; machineId?: string } | null> {
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

/**
 * Force-refresh the sandbox URL for a user.
 * Fly.io machines use Fly Proxy — no signed URL refresh needed.
 */
export async function forceRefreshSignedUrl(userId: string): Promise<string | null> {
  const sandbox = await getSandboxByUserId(userId)
  if (!sandbox) return null
  return sandbox.signed_url
}
