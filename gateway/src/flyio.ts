/**
 * Fly.io Machines API client for sandbox lifecycle management.
 *
 * Replaces Daytona SDK for sandbox provisioning. Each user gets a Fly Machine
 * with JuiceFS-backed persistent storage.
 */

import { config } from './config.js'
import { log, logError } from './log.js'

const FLY_API = 'https://api.machines.dev/v1'

function slog(msg: string, data?: Record<string, unknown>) { log('flyio', msg, data) }

interface FlyMachineConfig {
  image: string
  env: Record<string, string>
  guest: { cpus: number; memory_mb: number }
  restart: { policy: string }
  auto_destroy: boolean
}

interface FlyMachine {
  id: string
  name: string
  state: string
  region: string
  instance_id: string
  private_ip: string
  config: FlyMachineConfig
  created_at: string
  updated_at: string
}

// ── API helpers ──

async function flyApi<T>(
  method: string,
  path: string,
  body?: unknown,
  timeout = 30000
): Promise<T> {
  const url = `${FLY_API}/apps/${config.flyio.appName}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${config.flyio.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Fly API ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`)
    }

    const contentType = res.headers.get('content-type')
    if (contentType?.includes('application/json')) {
      return await res.json() as T
    }
    return undefined as T
  } finally {
    clearTimeout(timer)
  }
}

// ── Machine lifecycle ──

export interface CreateMachineOptions {
  userId: string
  llmProxyUrl: string
  virtualKey: string
  region?: string
}

/**
 * Create and start a new Fly Machine for a user.
 * Returns the machine ID and private IP.
 */
export async function createMachine(opts: CreateMachineOptions): Promise<{
  machineId: string
  privateIp: string
}> {
  const region = opts.region ?? config.flyio.region

  slog('creating machine...', { userId: opts.userId, region })

  const machine = await flyApi<FlyMachine>('POST', '/machines', {
    region,
    config: {
      image: config.flyio.sandboxImage,
      env: {
        // User identity
        MEIOS_USER_ID: opts.userId,
        // LLM proxy (all providers via LiteLLM)
        OPENAI_BASE_URL: opts.llmProxyUrl,
        OPENAI_API_KEY: opts.virtualKey,
        ANTHROPIC_BASE_URL: opts.llmProxyUrl,
        ANTHROPIC_API_KEY: opts.virtualKey,
        GEMINI_BASE_URL: opts.llmProxyUrl + '/google/v1beta',
        GEMINI_API_KEY: opts.virtualKey,
        GOOGLE_API_KEY: opts.virtualKey,
        KIMI_BASE_URL: opts.llmProxyUrl + '/moonshot',
        KIMI_API_KEY: opts.virtualKey,
        // JuiceFS persistent storage
        JUICEFS_TOKEN: config.flyio.juicefsToken,
        JUICEFS_GCS_KEY_B64: config.flyio.gcsKeyB64,
        JUICEFS_VOLUME: config.flyio.juicefsVolume,
      },
      guest: {
        cpus: 1,
        memory_mb: 512,
      },
      restart: { policy: 'on-fail' },
      auto_destroy: false,
    },
  }, 60000)

  slog('machine created', { machineId: machine.id, region: machine.region })

  // Wait for machine to be in started state
  await waitForState(machine.id, 'started', 30000)

  return {
    machineId: machine.id,
    privateIp: machine.private_ip,
  }
}

/**
 * Start a stopped machine.
 */
export async function startMachine(machineId: string): Promise<void> {
  slog('starting machine...', { machineId })
  await flyApi('POST', `/machines/${machineId}/start`)
  await waitForState(machineId, 'started', 30000)
  slog('machine started', { machineId })
}

/**
 * Stop a running machine (releases CPU/memory, keeps disk).
 */
export async function stopMachine(machineId: string): Promise<void> {
  slog('stopping machine...', { machineId })
  await flyApi('POST', `/machines/${machineId}/stop`)
  slog('machine stopped', { machineId })
}

/**
 * Destroy a machine completely.
 */
export async function destroyMachine(machineId: string): Promise<void> {
  slog('destroying machine...', { machineId })
  await flyApi('DELETE', `/machines/${machineId}?force=true`)
  slog('machine destroyed', { machineId })
}

/**
 * Get machine status.
 */
export async function getMachine(machineId: string): Promise<FlyMachine | null> {
  try {
    return await flyApi<FlyMachine>('GET', `/machines/${machineId}`)
  } catch {
    return null
  }
}

/**
 * Wait for a machine to reach a target state.
 */
async function waitForState(machineId: string, state: string, timeoutMs: number): Promise<void> {
  // Fly Machines API has a wait endpoint
  try {
    await flyApi('GET', `/machines/${machineId}/wait?state=${state}&timeout=${Math.floor(timeoutMs / 1000)}`, undefined, timeoutMs + 5000)
  } catch (err: any) {
    logError('flyio', `wait for state ${state} failed`, err, { machineId })
    throw err
  }
}

/**
 * Check if a machine's gateway is healthy.
 * Uses Fly's internal DNS (machineId.vm.appName.internal) for direct access.
 */
export async function checkHealth(privateIp: string, port = 18800): Promise<boolean> {
  try {
    const res = await fetch(`http://[${privateIp}]:${port}/health`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return false
    const body = await res.json() as { ok: boolean }
    return body.ok === true
  } catch {
    return false
  }
}
