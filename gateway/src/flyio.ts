/**
 * Fly.io Machines API client for sandbox lifecycle management.
 *
 * Each user gets a Fly Machine
 * with JuiceFS-backed persistent storage.
 *
 * Machines are accessed via Fly Proxy (public URL + fly-force-instance-id header)
 * rather than private IPv6, so the outer gateway can run on any cloud.
 */

import { randomBytes } from 'node:crypto'
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
  services?: Array<{
    ports: Array<{ port: number; handlers: string[] }>
    protocol: string
    internal_port: number
    auto_stop_machines?: string
    auto_start_machines?: boolean
    min_machines_running?: number
  }>
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
 * Exposes port 18800 via Fly Proxy for external access.
 */
export async function createMachine(opts: CreateMachineOptions): Promise<{
  machineId: string
  machineSecret: string
}> {
  const region = opts.region ?? config.flyio.region
  const machineSecret = randomBytes(32).toString('hex')

  slog('creating machine...', { userId: opts.userId, region })

  const machine = await flyApi<FlyMachine>('POST', '/machines', {
    region,
    config: {
      image: config.flyio.sandboxImage,
      env: {
        // User identity
        MEIOS_USER_ID: opts.userId,
        // Per-machine gateway secret — sandbox checks this on every request
        GATEWAY_SECRET: machineSecret,
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
        // JuiceFS persistent storage (per-user isolation via --subdir)
        JUICEFS_TOKEN: config.flyio.juicefsToken,
        JUICEFS_GCS_KEY_B64: config.flyio.gcsKeyB64,
        JUICEFS_VOLUME: config.flyio.juicefsVolume,
        JUICEFS_SUBDIR: opts.userId,
        // R2 CDN URL (read-only, no credentials passed to sandbox)
        ...(config.r2?.publicUrl ? { R2_PUBLIC_URL: config.r2.publicUrl } : {}),
        // Gateway URL for presigned upload requests
        MEIOS_GATEWAY_URL: config.meios.gatewayUrl,
      },
      guest: {
        cpu_kind: 'shared',
        cpus: 1,
        memory_mb: 1024,
      },
      // Expose port 18800 via Fly Proxy (public HTTPS on fly.dev)
      services: [{
        ports: [
          { port: 443, handlers: ['tls', 'http'] },
          { port: 80, handlers: ['http'] },
        ],
        protocol: 'tcp',
        internal_port: 18800,
        auto_stop_machines: 'stop',    // Stop machine when idle (no traffic)
        auto_start_machines: true,      // Fly Proxy auto-starts on new traffic
        min_machines_running: 0,
      }],
      restart: { policy: 'on-failure' },
      auto_destroy: false,
    },
  }, 60000)

  slog('machine created', { machineId: machine.id, region: machine.region })

  // Wait for machine to be in started state
  await waitForState(machine.id, 'started', 30000)

  return { machineId: machine.id, machineSecret }
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
  try {
    await flyApi('GET', `/machines/${machineId}/wait?state=${state}&timeout=${Math.floor(timeoutMs / 1000)}`, undefined, timeoutMs + 5000)
  } catch (err: any) {
    logError('flyio', `wait for state ${state} failed`, err, { machineId })
    throw err
  }
}

/**
 * Build the Fly Proxy URL for reaching a specific machine.
 * Uses fly-force-instance-id header for routing.
 */
export function flyProxyUrl(): string {
  return `https://${config.flyio.appName}.fly.dev`
}

/**
 * Check if a machine's gateway is healthy via Fly Proxy.
 */
export async function checkHealth(machineId: string, machineSecret: string, port = 18800): Promise<boolean> {
  try {
    const res = await fetch(`${flyProxyUrl()}/health`, {
      headers: {
        'fly-force-instance-id': machineId,
        'X-Gateway-Secret': machineSecret,
      },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return false
    const body = await res.json() as { ok: boolean }
    return body.ok === true
  } catch {
    return false
  }
}
