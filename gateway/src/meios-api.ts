/**
 * Meio provisioning API.
 *
 * POST /api/v1/meios           — provision a meio from a built-in template
 * GET  /api/v1/meios           — list user's provisioned meios
 * DELETE /api/v1/meios/:type   — remove a provisioned meio
 *
 * Provisioning writes meio.json + SOUL.md to the sandbox via the proxy,
 * then checks credential requirements against user_credentials.
 */

import type { Context } from 'hono'
import type { AuthUser } from './auth.js'
import { resolveSandboxUrl, provisionFlyMachine } from './sandbox.js'
import { listCredentials } from './db.js'
import { log, logError } from './log.js'

function mlog(msg: string, data?: Record<string, unknown>) { log('meios-api', msg, data) }

// ── Built-in templates ──────────────────────────────────────

interface MeioTemplate {
  'meio.json': object
  'SOUL.md': string
}

const TEMPLATES: Record<string, MeioTemplate> = {
  wardrobe: {
    'meio.json': {
      id: 'wardrobe',
      name: '穿搭助手',
      version: '0.1.0',
      description: 'Closet management and outfit generation',
      tools: { builtin: ['coding'], custom: 'tools.ts' },
      secrets: {},
      allowedEndpoints: [],
      storage: { directories: ['closet', 'looks'] },
    },
    'SOUL.md': [
      '# 小周 · 穿搭助手模式 (meios)',
      '',
      '你是小周的穿搭助手人格，运行在 meios 轻量引擎上。',
      '',
      '## 你是谁',
      '',
      '一个懂时尚、有品味、说话直接的穿搭顾问。你记得用户衣橱里的每一件衣服，能根据场景、天气、心情推荐搭配方案。',
      '',
      '## 核心能力',
      '',
      '1. **识别衣物**：用户拍照上传衣服，你识别并记录到衣橱',
      '2. **记忆衣橱**：你了解用户拥有的所有衣物（存储在 closet/ 目录）',
      '3. **推荐搭配**：根据场景（约会、通勤、运动...）推荐搭配',
      '4. **生成效果图**：调用生图工具展示搭配效果',
      '',
      '## 风格',
      '',
      '- 说话简洁、有态度，像一个闺蜜/好友',
      '- 会直说"这件不适合那个场合"，不会一味迎合',
      '- 适当用一些时尚术语但不故弄玄虚',
      '- 中文为主',
      '',
      '## 工具使用',
      '',
      '- 调用 `generate_image` 等耗时工具前，**先回复用户一句话**（如"好的，我来帮你生成一张…"），让用户知道你在处理，不要让他们干等',
      '- 工具执行完成后，再回复结果',
      '',
      '## 记忆',
      '',
      '- 读 `MEMORY.md` 了解用户的风格偏好和历史',
      '- 衣橱数据在 `closet/` 目录下，每件衣物一个 markdown 文件',
      '- 生成的搭配图存在 `looks/` 目录下',
    ].join('\n'),
  },

  reader: {
    'meio.json': {
      id: 'reader',
      name: 'Reading Assistant',
      version: '0.1.0',
      description: 'Summarize web articles to Google Docs',
      tools: { builtin: ['coding'] },
      secrets: {
        google: {
          description: 'Google Service Account key (JSON)',
          required: true,
          setupUrl: 'https://meios.ai/docs/setup/google-sa',
        },
      },
      allowedEndpoints: [
        'docs.googleapis.com',
        'sheets.googleapis.com',
        'www.googleapis.com',
        'content-docs.googleapis.com',
      ],
      storage: { directories: ['articles', 'summaries'] },
    },
    'SOUL.md': [
      '# Reader — Reading Assistant',
      '',
      'You are a reading assistant that helps users summarize web articles and save them to Google Docs.',
      '',
      '## Capabilities',
      '',
      '1. **Summarize**: Take article content and produce concise summaries',
      '2. **Save to Google Docs**: Create Google Docs with summaries via the credential proxy',
      '3. **Organize**: Maintain an articles/ directory with saved summaries',
      '',
      '## How to save to Google Docs',
      '',
      'Use bash to call the credential proxy:',
      '```bash',
      'curl -s -X POST http://localhost:18800/internal/v1/proxy \\',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"url":"https://docs.googleapis.com/v1/documents","method":"POST","body":{...}}\'',
      '```',
      '',
      'The gateway injects Google credentials automatically — you never see them.',
      '',
      '## Style',
      '',
      '- Concise, structured summaries',
      '- Preserve key insights and data points',
      '- Default to user\'s language',
    ].join('\n'),
  },
}

const RESERVED_IDS = new Set(['default', 'internal', 'api', 'system'])

// ── Helpers ─────────────────────────────────────────────────

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

async function writeToSandbox(
  sandbox: ResolvedSandbox,
  filePath: string,
  content: string,
): Promise<boolean> {
  const url = `${sandbox.url}/files/${filePath}`
  const headers: Record<string, string> = { 'Content-Type': 'text/plain' }
  if (sandbox.machineId) {
    headers['fly-force-instance-id'] = sandbox.machineId
  }
  if (sandbox.machineSecret) {
    headers['X-Gateway-Secret'] = sandbox.machineSecret
  }

  const resp = await fetch(url, { method: 'PUT', headers, body: content })
  return resp.ok
}

async function readFromSandbox(
  sandbox: ResolvedSandbox,
  path: string,
): Promise<any | null> {
  const url = `${sandbox.url}/${path}`
  const headers: Record<string, string> = {}
  if (sandbox.machineId) {
    headers['fly-force-instance-id'] = sandbox.machineId
  }
  if (sandbox.machineSecret) {
    headers['X-Gateway-Secret'] = sandbox.machineSecret
  }

  const resp = await fetch(url, { headers })
  if (!resp.ok) return null
  return resp.json()
}

// ── POST /api/v1/meios ──────────────────────────────────────

export async function provisionMeio(c: Context): Promise<Response> {
  const user = c.get('user') as AuthUser
  const body = await c.req.json().catch(() => null)

  if (!body?.template || typeof body.template !== 'string') {
    return c.json({ ok: false, error: 'template (string) is required' }, 400)
  }

  const templateId = body.template
  if (!/^[a-z0-9][a-z0-9-]*$/.test(templateId) || templateId.length > 40) {
    return c.json({ ok: false, error: 'Invalid template ID' }, 400)
  }
  if (RESERVED_IDS.has(templateId)) {
    return c.json({ ok: false, error: `"${templateId}" is a reserved name` }, 400)
  }

  const template = TEMPLATES[templateId]
  if (!template) {
    return c.json({
      ok: false,
      error: `Unknown template "${templateId}". Available: ${Object.keys(TEMPLATES).join(', ')}`,
    }, 404)
  }

  try {
    // 1. Ensure sandbox exists
    const sandbox = await ensureSandbox(user.id)
    mlog('sandbox resolved', { userId: user.id, templateId })

    // 2. Write meio.json
    const meioJson = template['meio.json'] as any
    const basePath = `meios/${meioJson.id}`
    const jsonOk = await writeToSandbox(sandbox, `${basePath}/meio.json`, JSON.stringify(meioJson, null, 2))
    if (!jsonOk) {
      return c.json({ ok: false, error: 'Failed to write meio.json to sandbox' }, 502)
    }

    // 3. Write SOUL.md
    const soulOk = await writeToSandbox(sandbox, `${basePath}/SOUL.md`, template['SOUL.md'])
    if (!soulOk) {
      return c.json({ ok: false, error: 'Failed to write SOUL.md to sandbox' }, 502)
    }

    // 4. Create storage directories (write a .keep file in each)
    const dirs = meioJson.storage?.directories ?? []
    for (const dir of dirs) {
      await writeToSandbox(sandbox, `${basePath}/${dir}/.keep`, '')
    }

    mlog('template written', { userId: user.id, templateId, files: ['meio.json', 'SOUL.md', ...dirs.map((d: string) => `${d}/.keep`)] })

    // 5. Check credential requirements
    const secrets = meioJson.secrets ?? {}
    const requiredServices = Object.entries(secrets)
      .filter(([, v]: [string, any]) => v.required)
      .map(([k]: [string, any]) => k)

    let missingCredentials: string[] = []
    if (requiredServices.length > 0) {
      const userCreds = await listCredentials(user.id)
      const userServices = new Set(userCreds.map(c => c.service))
      missingCredentials = requiredServices.filter(s => !userServices.has(s))
    }

    // 6. Build response
    const response: any = {
      id: meioJson.id,
      name: meioJson.name,
      version: meioJson.version,
      description: meioJson.description,
      installed: true,
    }

    if (missingCredentials.length > 0) {
      response.missingCredentials = missingCredentials.map(service => ({
        service,
        ...secrets[service],
      }))
      response.ready = false
    } else {
      response.ready = true
    }

    mlog('provisioned', { userId: user.id, templateId, ready: response.ready, missingCredentials })
    return c.json({ ok: true, data: response }, 201)
  } catch (err: any) {
    logError('meios-api', 'provision failed', err, { userId: user.id, templateId })
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

    // Read meio list from sandbox
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

  if (!/^[a-z0-9][a-z0-9-]*$/.test(meioType)) {
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

    // Delete meio.json to "uninstall" — sandbox's GET /meios will no longer list it
    // SOUL.md and data files are left in place (soft delete)
    const url = `${resolved.url}/files/meios/${meioType}/meio.json`
    const headers: Record<string, string> = {}
    if (resolved.machineId) {
      headers['fly-force-instance-id'] = resolved.machineId
    }
    if (resolved.machineSecret) {
      headers['X-Gateway-Secret'] = resolved.machineSecret
    }

    // Use bash via chat to remove the file (sandbox doesn't have DELETE /files)
    // For now, overwrite meio.json with a tombstone
    const tombstone = JSON.stringify({ id: meioType, removed: true, removedAt: new Date().toISOString() })
    await writeToSandbox(resolved, `meios/${meioType}/meio.json`, tombstone)

    mlog('removed', { userId: user.id, meioType })
    return c.json({ ok: true, data: null })
  } catch (err: any) {
    logError('meios-api', 'remove failed', err, { userId: user.id, meioType })
    return c.json({ ok: false, error: err.message }, 500)
  }
}
