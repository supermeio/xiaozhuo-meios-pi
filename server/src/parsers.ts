/**
 * Content block parsing and JSONL session message extraction.
 *
 * These are the core parsing functions used by the gateway to transform
 * raw agent output into structured content blocks for the iOS client.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// ── Types ──

export interface ParsedContentBlock {
  type: 'text' | 'image'
  text?: string
  url?: string
  imageId?: string
  width?: number
  height?: number
  alt?: string
}

export interface ParsedMessage {
  role: 'user' | 'assistant'
  text: string
  content: ParsedContentBlock[]
}

// ── Regex patterns ──

export const IMAGE_RE = /!\[([^\]]*)\]\(([^)]+\.(png|jpg|jpeg|webp|gif))\)/g
export const BARE_PATH_RE = /(?:^|[\s`])(((?:workspace\/)?(?:images|closet|looks)\/[^\s`"'<>]+\.(png|jpg|jpeg|webp|gif)))(?:[\s`]|$)/gm

// ── Block helpers ──

/** Clean up orphaned markdown markers left by image extraction, preserve natural order. */
export function cleanupBlocks(blocks: ParsedContentBlock[]): ParsedContentBlock[] {
  return blocks
    .map(b => b.type === 'text'
      ? { ...b, text: b.text!.replace(/^\*{1,2}\s*$/gm, '').replace(/^\s*\*{1,2}$/gm, '').trim() }
      : b)
    .filter(b => b.type !== 'text' || b.text)
}

/**
 * Parse agent text into content blocks. Splits on markdown image
 * references, converting them to image blocks and keeping surrounding
 * text as text blocks.
 *
 * @param text - The raw agent text to parse
 * @param workspaceRoot - The workspace root directory for resolving file paths
 */
export function textToContentBlocks(text: string, workspaceRoot: string): ParsedContentBlock[] {
  const blocks: ParsedContentBlock[] = []
  let lastIndex = 0

  for (const match of text.matchAll(IMAGE_RE)) {
    const [fullMatch, alt, rawFilePath] = match
    const matchIndex = match.index!
    const filePath = rawFilePath.replace(/^workspace\//, '')

    const before = text.slice(lastIndex, matchIndex).trim()
    if (before) blocks.push({ type: 'text', text: before })

    const absPath = filePath.startsWith('/') ? filePath : resolve(workspaceRoot, filePath)
    if (existsSync(absPath)) {
      const imageId = `img-${filePath.replace(/[^a-z0-9]/gi, '-')}`
      blocks.push({
        type: 'image',
        url: `/files/${filePath}`,
        imageId,
        alt: alt || undefined,
      })
    } else {
      blocks.push({ type: 'text', text: fullMatch })
    }

    lastIndex = matchIndex + fullMatch.length
  }

  const remaining = text.slice(lastIndex).trim()
  if (remaining) blocks.push({ type: 'text', text: remaining })

  // If no image blocks found via markdown syntax, try bare file paths
  const hasImageBlock = blocks.some(b => b.type === 'image')
  if (!hasImageBlock) {
    const newBlocks: ParsedContentBlock[] = []
    const fullText = blocks.map(b => b.text ?? '').join('\n')
    let bareLastIndex = 0
    let foundBareImage = false

    for (const match of fullText.matchAll(BARE_PATH_RE)) {
      const rawPath = match[1]
      const filePath = rawPath.replace(/^workspace\//, '')
      const matchIndex = match.index!
      const absPath = resolve(workspaceRoot, filePath)

      if (existsSync(absPath)) {
        const before = fullText.slice(bareLastIndex, matchIndex).trim()
        if (before) newBlocks.push({ type: 'text', text: before })

        const imageId = `img-${filePath.replace(/[^a-z0-9]/gi, '-')}`
        newBlocks.push({
          type: 'image',
          url: `/files/${filePath}`,
          imageId,
          alt: filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || undefined,
        })
        bareLastIndex = matchIndex + match[0].length
        foundBareImage = true
      }
    }

    if (foundBareImage) {
      const remaining = fullText.slice(bareLastIndex).trim()
      if (remaining) newBlocks.push({ type: 'text', text: remaining })
      return cleanupBlocks(newBlocks)
    }
  }

  if (blocks.length === 0) blocks.push({ type: 'text', text })

  return cleanupBlocks(blocks)
}

/**
 * Parse a session JSONL file and extract user/assistant messages.
 *
 * @param content - Raw JSONL string content
 * @param workspaceRoot - The workspace root directory for resolving file paths
 */
export function parseJsonlMessages(content: string, workspaceRoot: string): ParsedMessage[] {
  const messages: ParsedMessage[] = []
  const lines = content.split('\n').filter(Boolean)

  for (const line of lines) {
    try {
      const entry = JSON.parse(line)

      if (entry.type !== 'message') continue

      const msg = entry.message
      if (!msg || !msg.role || !msg.content) continue

      if (msg.role !== 'user' && msg.role !== 'assistant') continue

      const blocks = Array.isArray(msg.content) ? msg.content : [msg.content]

      const rawText = blocks
        .filter((b: any) => b.type === 'text' && typeof b.text === 'string' && b.text.trim())
        .map((b: any) => b.text)
        .join('\n')

      if (!rawText) continue

      const contentBlocks = textToContentBlocks(rawText, workspaceRoot)
      const text = contentBlocks
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')

      messages.push({ role: msg.role, text, content: contentBlocks })
    } catch {
      // Skip malformed lines
    }
  }

  return messages
}
