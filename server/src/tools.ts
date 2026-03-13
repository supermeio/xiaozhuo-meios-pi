import { Type, type Static, type TSchema } from '@sinclair/typebox'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import type { Theme } from '@mariozechner/pi-coding-agent'
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomBytes } from 'node:crypto'

// ── workspace root (resolved at runtime) ──
let _workspaceRoot = ''
export function setWorkspaceRoot(root: string) { _workspaceRoot = root }
function ws(...parts: string[]) { return join(_workspaceRoot, ...parts) }

// ── Helper: make AgentToolResult ──
function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: 'text', text }], details }
}

// ════════════════════════════════════════════
//  Tool 1: save_clothing — 保存衣物到衣橱
// ════════════════════════════════════════════

const SaveClothingParams = Type.Object({
  id: Type.String({ description: '衣物 ID，英文短横线命名，如 white-uniqlo-shirt' }),
  name: Type.String({ description: '衣物名称，如 "白色优衣库衬衫"' }),
  category: Type.String({ description: '类别：上装/下装/外套/鞋子/包/配饰/内搭' }),
  color: Type.String({ description: '颜色' }),
  brand: Type.Optional(Type.String({ description: '品牌' })),
  season: Type.Optional(Type.String({ description: '适用季节，如 春夏/秋冬/四季' })),
  occasions: Type.Optional(Type.Array(Type.String(), { description: '适用场景，如 ["通勤","约会"]' })),
  notes: Type.Optional(Type.String({ description: '备注' })),
})

export const saveClothingTool: ToolDefinition<typeof SaveClothingParams, string> = {
  name: 'save_clothing',
  label: '保存衣物',
  description: '将一件衣物保存到用户的衣橱。在用户描述或上传衣物照片后调用此工具记录衣物信息。',
  parameters: SaveClothingParams,
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const id = params.id as string
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id.length > 80) {
      return textResult('Invalid clothing ID. Use lowercase letters, numbers, and hyphens only.', '')
    }

    const dir = ws('closet')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const lines = [
      `# ${params.name}`,
      '',
      `- **类别**: ${params.category}`,
      `- **颜色**: ${params.color}`,
    ]
    if (params.brand) lines.push(`- **品牌**: ${params.brand}`)
    if (params.season) lines.push(`- **季节**: ${params.season}`)
    if (params.occasions?.length) lines.push(`- **场景**: ${params.occasions.join('、')}`)
    if (params.notes) lines.push(`- **备注**: ${params.notes}`)

    const photoDir = ws('closet', 'photos')
    if (existsSync(join(photoDir, `${params.id}.jpg`)) || existsSync(join(photoDir, `${params.id}.png`))) {
      lines.push(`- **照片**: photos/${params.id}.*`)
    }

    const filePath = ws('closet', `${params.id}.md`)
    writeFileSync(filePath, lines.join('\n') + '\n')
    return textResult(`已保存衣物「${params.name}」到衣橱 (${filePath})`, filePath)
  },
}

// ════════════════════════════════════════════
//  Tool 2: list_closet — 列出衣橱
// ════════════════════════════════════════════

const ListClosetParams = Type.Object({
  category: Type.Optional(Type.String({ description: '按类别过滤：上装/下装/外套/鞋子/包/配饰/内搭' })),
})

export const listClosetTool: ToolDefinition<typeof ListClosetParams, string[]> = {
  name: 'list_closet',
  label: '查看衣橱',
  description: '列出用户衣橱中的所有衣物。可按类别过滤。',
  parameters: ListClosetParams,
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const dir = ws('closet')
    if (!existsSync(dir)) return textResult('衣橱是空的，还没有添加任何衣物。', [])

    const files = readdirSync(dir).filter(f => f.endsWith('.md'))
    if (files.length === 0) return textResult('衣橱是空的，还没有添加任何衣物。', [])

    const items: string[] = []
    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8')
      if (params.category) {
        if (!content.includes(`**类别**: ${params.category}`)) continue
      }
      // Extract first line as name
      const name = content.split('\n')[0]?.replace(/^#\s*/, '') ?? file
      items.push(`- ${name} (${file.replace('.md', '')})`)
    }

    if (items.length === 0) {
      return textResult(params.category ? `衣橱里没有「${params.category}」类别的衣物。` : '衣橱是空的。', [])
    }
    return textResult(`衣橱共 ${items.length} 件：\n${items.join('\n')}`, files)
  },
}

// ════════════════════════════════════════════
//  Tool 3: get_clothing — 查看单件衣物详情
// ════════════════════════════════════════════

const GetClothingParams = Type.Object({
  id: Type.String({ description: '衣物 ID' }),
})

export const getClothingTool: ToolDefinition<typeof GetClothingParams, string> = {
  name: 'get_clothing',
  label: '查看衣物',
  description: '查看衣橱中某件衣物的详细信息。',
  parameters: GetClothingParams,
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const id = params.id as string
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id.length > 80) {
      return textResult('Invalid clothing ID. Use lowercase letters, numbers, and hyphens only.', '')
    }

    const filePath = ws('closet', `${params.id}.md`)
    if (!existsSync(filePath)) {
      return textResult(`找不到衣物「${params.id}」。`, '')
    }
    const content = readFileSync(filePath, 'utf-8')
    return textResult(content, content)
  },
}

// ════════════════════════════════════════════
//  Tool 4: suggest_outfit — 推荐搭配
// ════════════════════════════════════════════

const SuggestOutfitParams = Type.Object({
  occasion: Type.String({ description: '场景描述，如 "周末约会"、"公司面试"、"朋友聚餐"' }),
  weather: Type.Optional(Type.String({ description: '天气情况，如 "晴天25度"、"下雨12度"' })),
  preferences: Type.Optional(Type.String({ description: '用户额外偏好，如 "想穿裙子"、"要显瘦"' })),
})

export const suggestOutfitTool: ToolDefinition<typeof SuggestOutfitParams, string> = {
  name: 'suggest_outfit',
  label: '推荐搭配',
  description: '根据场景、天气和用户偏好，从衣橱中推荐搭配方案。调用此工具前应先用 list_closet 获取衣橱内容。此工具仅记录推荐，实际推荐逻辑由你（LLM）完成。',
  parameters: SuggestOutfitParams,
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    // This tool mainly serves as structured input; the LLM does the actual reasoning
    const dir = ws('closet')
    if (!existsSync(dir)) return textResult('衣橱是空的，无法推荐搭配。', '')

    const files = readdirSync(dir).filter(f => f.endsWith('.md'))
    const allClothes = files.map(f => {
      const content = readFileSync(join(dir, f), 'utf-8')
      return `### ${f.replace('.md', '')}\n${content}`
    }).join('\n\n')

    const context = [
      `## 搭配请求`,
      `- **场景**: ${params.occasion}`,
      params.weather ? `- **天气**: ${params.weather}` : '',
      params.preferences ? `- **偏好**: ${params.preferences}` : '',
      '',
      `## 当前衣橱 (${files.length} 件)`,
      allClothes,
    ].filter(Boolean).join('\n')

    return textResult(context, context)
  },
}

// ════════════════════════════════════════════
//  Tool 5: generate_image — 生成图片
// ════════════════════════════════════════════

const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const

const GenerateImageParams = Type.Object({
  prompt: Type.String({ description: '图片描述，具体描述你想生成的画面内容' }),
  filename: Type.String({ description: '保存文件名（不含扩展名），如 casual-spring-outfit' }),
  subfolder: Type.Optional(Type.String({ description: '保存子目录（相对于 workspace），如 outfits/2026-03-14。默认为 outfits' })),
  aspectRatio: Type.Optional(Type.String({ description: '宽高比：1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9。默认 3:4（适合服装展示）' })),
  quality: Type.Optional(Type.String({ description: '质量：standard（快速，默认）或 pro（高质量，较慢）' })),
})

export const generateImageTool: ToolDefinition<typeof GenerateImageParams, string> = {
  name: 'generate_image',
  label: '生成图片',
  description: '使用 AI 生成图片。适用于生成穿搭效果图、服装展示图等。图片会保存到 workspace 目录。',
  parameters: GenerateImageParams,
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const filename = params.filename as string
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(filename) || filename.length > 80) {
      return textResult('Invalid filename. Use lowercase letters, numbers, hyphens, and dots only.', '')
    }

    const subfolder = (params.subfolder as string) || 'outfits'
    const aspectRatio = (params.aspectRatio as string) || '3:4'
    const quality = (params.quality as string) || 'standard'
    const modelId = quality === 'pro'
      ? 'gemini-3-pro-image-preview'
      : 'gemini-3.1-flash-image-preview'

    // Build output dir
    const outDir = ws(subfolder)
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

    // Call Gemini image generation via LiteLLM proxy
    const geminiBaseUrl = process.env.GEMINI_BASE_URL
    const geminiApiKey = process.env.GEMINI_API_KEY
    if (!geminiBaseUrl || !geminiApiKey) {
      return textResult('Image generation not available: missing GEMINI_BASE_URL or GEMINI_API_KEY.', '')
    }

    const apiUrl = `${geminiBaseUrl}/models/${modelId}:generateContent`
    let response: Response
    try {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiApiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: params.prompt }] }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            ...(aspectRatio !== '1:1' ? { aspectRatio } : {}),
          },
        }),
      })
    } catch (err: any) {
      return textResult(`Image generation request failed: ${err.message}`, '')
    }

    if (!response.ok) {
      const errBody = await response.text()
      return textResult(`Image generation failed (${response.status}): ${errBody.slice(0, 200)}`, '')
    }

    const result = await response.json() as any
    const parts = result?.candidates?.[0]?.content?.parts ?? []

    // Extract image data
    const imagePart = parts.find((p: any) => p.inlineData?.data)
    if (!imagePart) {
      const textParts = parts.filter((p: any) => p.text).map((p: any) => p.text).join('\n')
      return textResult(`No image generated. Model response: ${textParts || 'empty'}`, '')
    }

    const mimeType = imagePart.inlineData.mimeType || 'image/png'
    const ext = mimeType.includes('webp') ? 'webp' : mimeType.includes('jpeg') ? 'jpg' : 'png'
    const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64')

    // Save to workspace
    const outputFilename = `${filename}.${ext}`
    const outputPath = join(outDir, outputFilename)
    writeFileSync(outputPath, imageBuffer)

    // Extract companion text if any
    const textContent = parts.filter((p: any) => p.text).map((p: any) => p.text).join('\n')

    const relativePath = `${subfolder}/${outputFilename}`
    const sizeKb = Math.round(imageBuffer.length / 1024)
    const summary = [
      `已生成图片并保存到 ${relativePath} (${sizeKb}KB)`,
      `模型: ${modelId}，宽高比: ${aspectRatio}`,
      textContent ? `描述: ${textContent}` : '',
    ].filter(Boolean).join('\n')

    return textResult(summary, relativePath)
  },
}

// ── Export all tools ──
export const wardrobeTools: ToolDefinition[] = [
  saveClothingTool,
  listClosetTool,
  getClothingTool,
  suggestOutfitTool,
  generateImageTool,
]
