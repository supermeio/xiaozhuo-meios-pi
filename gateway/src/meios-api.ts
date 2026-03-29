/**
 * Meio provisioning API.
 *
 * POST /api/v1/meios           — provision a meio (inline or repo)
 * GET  /api/v1/meios           — list user's provisioned meios
 * DELETE /api/v1/meios/:type   — remove a provisioned meio
 *
 * Two template sources:
 *   1. Inline:    { inline: { "meio.json": {...}, "SOUL.md": "..." } }
 *   2. Git repo:  { repo: "https://github.com/user/repo", branch?, path? }
 *
 * For private repos, user must first store a GitHub token via
 * PUT /api/v1/credentials/github.
 */

import type { Context } from 'hono'
import type { AuthUser } from './auth.js'
import { resolveSandboxUrl, provisionFlyMachine } from './sandbox.js'
import { listCredentials, getCredential } from './db.js'
import { config } from './config.js'
import { decrypt } from './crypto.js'
import { log, logError } from './log.js'

function mlog(msg: string, data?: Record<string, unknown>) { log('meios-api', msg, data) }

// ── MeioManifest validation ─────────────────────────────────

interface MeioManifest {
  $schema?: string
  id: string
  name: string
  version: string
  description?: string
  soul?: string
  tools?: { builtin?: string[]; custom?: string | null }
  secrets?: Record<string, { description: string; required?: boolean; setupUrl?: string }>
  allowedEndpoints?: string[]
  model?: { default?: string; thinking?: string }
  session?: { scope?: string; idle?: { resetAfterMinutes?: number | null } }
  env?: Record<string, string>
  storage?: { directories?: string[] }
  author?: string
  homepage?: string
  license?: string
}

const RESERVED_IDS = new Set(['default', 'internal', 'api', 'system'])
const ID_RE = /^[a-z0-9][a-z0-9-]*$/
const SEMVER_RE = /^\d+\.\d+\.\d+/
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
const SECRET_KEY_RE = /^[a-z0-9_]+$/
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/

function validateManifest(m: any): string | null {
  if (!m || typeof m !== 'object') return 'meio.json must be a JSON object'
  if (typeof m.id !== 'string' || !ID_RE.test(m.id) || m.id.length > 40)
    return 'id must be [a-z0-9-], 1-40 chars, start with alphanumeric'
  if (RESERVED_IDS.has(m.id)) return `"${m.id}" is a reserved name`
  if (typeof m.name !== 'string' || !m.name.trim()) return 'name is required'
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) return 'version must be semver (e.g., "0.1.0")'

  if (m.allowedEndpoints) {
    if (!Array.isArray(m.allowedEndpoints)) return 'allowedEndpoints must be an array'
    for (const ep of m.allowedEndpoints) {
      if (typeof ep !== 'string' || !HOSTNAME_RE.test(ep)) return `invalid endpoint hostname: "${ep}"`
    }
  }

  if (m.secrets) {
    if (typeof m.secrets !== 'object') return 'secrets must be an object'
    for (const key of Object.keys(m.secrets)) {
      if (!SECRET_KEY_RE.test(key)) return `invalid secrets key: "${key}" (must be [a-z0-9_])`
    }
  }

  if (m.tools?.custom && typeof m.tools.custom === 'string') {
    if (m.tools.custom.includes('..')) return 'tools.custom must not contain ".."'
  }

  if (m.env) {
    if (typeof m.env !== 'object') return 'env must be an object'
    for (const [key, val] of Object.entries(m.env)) {
      if (!ENV_KEY_RE.test(key)) return `invalid env key: "${key}" (must be UPPER_SNAKE_CASE)`
      if (typeof val !== 'string') return `env.${key} must be a string`
    }
  }

  if (m.session?.idle?.resetAfterMinutes != null) {
    if (typeof m.session.idle.resetAfterMinutes !== 'number' || m.session.idle.resetAfterMinutes < 5)
      return 'session.idle.resetAfterMinutes must be >= 5'
  }

  return null // valid
}

// ── GitHub repo fetching ────────────────────────────────────

/**
 * Parse a GitHub URL into owner/repo.
 * Supports: https://github.com/owner/repo, https://github.com/owner/repo.git
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?(?:\/.*)?$/)
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

/**
 * Fetch a file from a GitHub repo via the Contents API.
 * Uses the user's GitHub token (from credential proxy) for private repos.
 */
async function fetchGitHubFile(
  owner: string,
  repo: string,
  filePath: string,
  branch: string,
  githubToken?: string,
): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3.raw',
    'User-Agent': 'meios-gateway',
  }
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`
  }

  const resp = await fetch(url, { headers })
  if (!resp.ok) return null
  return resp.text()
}

/**
 * Resolve the user's GitHub token from encrypted credential storage.
 */
async function resolveGitHubToken(userId: string): Promise<string | null> {
  if (!config.credentialEncryptionKey) return null
  const cred = await getCredential(userId, 'github')
  if (!cred) return null

  try {
    const hex = cred.encrypted_data.startsWith('\\x')
      ? cred.encrypted_data.slice(2)
      : cred.encrypted_data
    const ivHex = cred.iv.startsWith('\\x') ? cred.iv.slice(2) : cred.iv
    const plaintext = decrypt(
      Buffer.from(hex, 'hex'),
      Buffer.from(ivHex, 'hex'),
      config.credentialEncryptionKey,
    )
    const parsed = JSON.parse(plaintext)
    return parsed.token ?? null
  } catch {
    return null
  }
}

// ── Sandbox helpers ─────────────────────────────────────────

interface ResolvedSandbox {
  url: string
  machineId: string
  machineSecret?: string
}

async function ensureSandbox(userId: string): Promise<ResolvedSandbox> {
  const resolved = await resolveSandboxUrl(userId)
  if (resolved) return resolved
  const result = await provisionFlyMachine(userId)
  return {
    url: result.signedUrl,
    machineId: result.sandbox.daytona_id,
    machineSecret: result.sandbox.machine_secret ?? undefined,
  }
}

function sandboxHeaders(sandbox: ResolvedSandbox): Record<string, string> {
  const h: Record<string, string> = {}
  if (sandbox.machineId) h['fly-force-instance-id'] = sandbox.machineId
  if (sandbox.machineSecret) h['X-Gateway-Secret'] = sandbox.machineSecret
  return h
}

async function writeToSandbox(
  sandbox: ResolvedSandbox,
  filePath: string,
  content: string,
): Promise<boolean> {
  const url = `${sandbox.url}/files/${filePath}`
  const headers = { ...sandboxHeaders(sandbox), 'Content-Type': 'text/plain' }
  const resp = await fetch(url, { method: 'PUT', headers, body: content })
  return resp.ok
}

async function readFromSandbox(
  sandbox: ResolvedSandbox,
  path: string,
): Promise<any | null> {
  const url = `${sandbox.url}/${path}`
  const resp = await fetch(url, { headers: sandboxHeaders(sandbox) })
  if (!resp.ok) return null
  return resp.json()
}

// ── Template resolution ─────────────────────────────────────

interface ResolvedTemplate {
  manifest: MeioManifest
  soul: string
  source: 'inline' | 'repo'
}

/**
 * Resolve template from inline definition or GitHub repo.
 */
async function resolveTemplate(
  body: any,
  userId: string,
): Promise<{ template: ResolvedTemplate } | { error: string; status: number }> {

  // Mode 1: Inline template
  if (body.inline && typeof body.inline === 'object') {
    const inline = body.inline
    if (!inline['meio.json'] || typeof inline['meio.json'] !== 'object') {
      return { error: 'inline["meio.json"] (object) is required', status: 400 }
    }
    const validationErr = validateManifest(inline['meio.json'])
    if (validationErr) {
      return { error: `Invalid meio.json: ${validationErr}`, status: 400 }
    }
    const soul = typeof inline['SOUL.md'] === 'string' ? inline['SOUL.md'] : ''
    return { template: { manifest: inline['meio.json'], soul, source: 'inline' } }
  }

  // Mode 2: Git repo
  if (body.repo && typeof body.repo === 'string') {
    const parsed = parseGitHubUrl(body.repo)
    if (!parsed) {
      return { error: 'Only GitHub repos are supported (https://github.com/owner/repo)', status: 400 }
    }

    const branch = body.branch ?? 'main'
    const basePath = body.path ? body.path.replace(/^\/|\/$/g, '') : ''
    const meioJsonPath = basePath ? `${basePath}/meio.json` : 'meio.json'
    const soulPath = basePath ? `${basePath}/SOUL.md` : 'SOUL.md'

    // Try fetching without auth first (public repo), then with GitHub token
    let githubToken: string | null = null
    let meioJsonRaw = await fetchGitHubFile(parsed.owner, parsed.repo, meioJsonPath, branch)

    if (!meioJsonRaw) {
      // Try with user's GitHub token for private repos
      githubToken = await resolveGitHubToken(userId)
      if (githubToken) {
        meioJsonRaw = await fetchGitHubFile(parsed.owner, parsed.repo, meioJsonPath, branch, githubToken)
      }
      if (!meioJsonRaw) {
        const hint = githubToken
          ? 'meio.json not found (checked with GitHub token)'
          : 'meio.json not found. For private repos, store a GitHub token: PUT /api/v1/credentials/github { credential: { token: "ghp_..." } }'
        return { error: hint, status: 404 }
      }
    }

    let manifest: MeioManifest
    try {
      manifest = JSON.parse(meioJsonRaw)
    } catch {
      return { error: 'meio.json in repo is not valid JSON', status: 422 }
    }

    const validationErr = validateManifest(manifest)
    if (validationErr) {
      return { error: `Invalid meio.json in repo: ${validationErr}`, status: 422 }
    }

    const soul = await fetchGitHubFile(parsed.owner, parsed.repo, soulPath, branch, githubToken ?? undefined) ?? ''

    return { template: { manifest, soul, source: 'repo' } }
  }

  return {
    error: 'Either "inline" (object) or "repo" (GitHub URL) is required',
    status: 400,
  }
}

// ── Credential check ────────────────────────────────────────

async function checkCredentials(manifest: MeioManifest, userId: string) {
  const secrets = manifest.secrets ?? {}
  const requiredServices = Object.entries(secrets)
    .filter(([, v]) => v.required)
    .map(([k]) => k)

  if (requiredServices.length === 0) return { ready: true, missing: [] }

  const userCreds = await listCredentials(userId)
  const userServices = new Set(userCreds.map(c => c.service))
  const missing = requiredServices.filter(s => !userServices.has(s))

  return {
    ready: missing.length === 0,
    missing: missing.map(service => ({ service, ...secrets[service] })),
  }
}

// ── POST /api/v1/meios ──────────────────────────────────────

export async function provisionMeio(c: Context): Promise<Response> {
  const user = c.get('user') as AuthUser
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ ok: false, error: 'JSON body required' }, 400)

  // Resolve template from builtin / inline / repo
  const result = await resolveTemplate(body, user.id)
  if ('error' in result) {
    return c.json({ ok: false, error: result.error }, result.status)
  }

  const { manifest, soul, source } = result.template

  try {
    // 1. Ensure sandbox exists
    const sandbox = await ensureSandbox(user.id)
    mlog('sandbox resolved', { userId: user.id, meioId: manifest.id, source })

    // 2. Write meio.json
    const basePath = `meios/${manifest.id}`
    const jsonOk = await writeToSandbox(sandbox, `${basePath}/meio.json`, JSON.stringify(manifest, null, 2))
    if (!jsonOk) {
      return c.json({ ok: false, error: 'Failed to write meio.json to sandbox' }, 502)
    }

    // 3. Write SOUL.md (if provided)
    if (soul) {
      const soulOk = await writeToSandbox(sandbox, `${basePath}/SOUL.md`, soul)
      if (!soulOk) {
        return c.json({ ok: false, error: 'Failed to write SOUL.md to sandbox' }, 502)
      }
    }

    // 4. Create storage directories
    const dirs = manifest.storage?.directories ?? []
    for (const dir of dirs) {
      await writeToSandbox(sandbox, `${basePath}/${dir}/.keep`, '')
    }

    mlog('template written', {
      userId: user.id, meioId: manifest.id, source,
      files: ['meio.json', ...(soul ? ['SOUL.md'] : []), ...dirs.map(d => `${d}/.keep`)],
    })

    // 5. Check credential requirements
    const creds = await checkCredentials(manifest, user.id)

    // 6. Build response
    const data: Record<string, any> = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      source,
      installed: true,
      ready: creds.ready,
    }
    if (!creds.ready) {
      data.missingCredentials = creds.missing
    }

    mlog('provisioned', { userId: user.id, meioId: manifest.id, source, ready: creds.ready })
    return c.json({ ok: true, data }, 201)
  } catch (err: any) {
    logError('meios-api', 'provision failed', err, { userId: user.id, meioId: manifest.id, source })
    return c.json({ ok: false, error: `Provisioning failed: ${err.message}` }, 500)
  }
}

// ── GET /api/v1/meios ───────────────────────────────────────

export async function listMeios(c: Context): Promise<Response> {
  const user = c.get('user') as AuthUser

  try {
    const resolved = await resolveSandboxUrl(user.id)
    if (!resolved) {
      return c.json({ ok: true, data: { meios: [] } })
    }

    const result = await readFromSandbox(resolved, 'meios')
    if (!result?.ok) {
      return c.json({ ok: true, data: { meios: [] } })
    }

    return c.json({ ok: true, data: result.data })
  } catch (err: any) {
    logError('meios-api', 'list failed', err, { userId: user.id })
    return c.json({ ok: false, error: err.message }, 500)
  }
}

// ── DELETE /api/v1/meios/:type ──────────────────────────────

export async function removeMeio(c: Context): Promise<Response> {
  const user = c.get('user') as AuthUser
  const meioType = c.req.param('type')!

  if (!ID_RE.test(meioType)) {
    return c.json({ ok: false, error: 'Invalid meio type' }, 400)
  }
  if (meioType === 'default') {
    return c.json({ ok: false, error: 'Cannot remove default meio' }, 400)
  }

  try {
    const resolved = await resolveSandboxUrl(user.id)
    if (!resolved) {
      return c.json({ ok: false, error: 'No sandbox found' }, 404)
    }

    const tombstone = JSON.stringify({ id: meioType, removed: true, removedAt: new Date().toISOString() })
    await writeToSandbox(resolved, `meios/${meioType}/meio.json`, tombstone)

    mlog('removed', { userId: user.id, meioType })
    return c.json({ ok: true, data: null })
  } catch (err: any) {
    logError('meios-api', 'remove failed', err, { userId: user.id, meioType })
    return c.json({ ok: false, error: err.message }, 500)
  }
}
