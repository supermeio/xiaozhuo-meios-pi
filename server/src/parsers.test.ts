import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  textToContentBlocks,
  parseJsonlMessages,
  cleanupBlocks,
  IMAGE_RE,
  BARE_PATH_RE,
  type ParsedContentBlock,
} from './parsers.js'

// ── Test workspace setup ──

let WORKSPACE: string

beforeEach(() => {
  WORKSPACE = resolve(tmpdir(), `parsers-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(WORKSPACE, { recursive: true })
})

afterEach(() => {
  rmSync(WORKSPACE, { recursive: true, force: true })
})

/** Create a file in the test workspace */
function createFile(relPath: string, content = '') {
  const absPath = resolve(WORKSPACE, relPath)
  mkdirSync(resolve(absPath, '..'), { recursive: true })
  writeFileSync(absPath, content)
}

// ── textToContentBlocks ──

describe('textToContentBlocks', () => {
  describe('plain text (no images)', () => {
    it('returns a single text block for plain text', () => {
      const blocks = textToContentBlocks('Hello, world!', WORKSPACE)
      expect(blocks).toEqual([{ type: 'text', text: 'Hello, world!' }])
    })

    it('returns a single text block for multiline text', () => {
      const text = 'Line 1\nLine 2\nLine 3'
      const blocks = textToContentBlocks(text, WORKSPACE)
      expect(blocks).toHaveLength(1)
      expect(blocks[0].type).toBe('text')
    })

    it('returns empty array for empty string (cleaned up)', () => {
      const blocks = textToContentBlocks('', WORKSPACE)
      expect(blocks).toHaveLength(0)
    })
  })

  describe('markdown image syntax', () => {
    it('extracts image block when file exists', () => {
      createFile('images/outfit.png')
      const text = 'Here is your outfit: ![outfit](images/outfit.png)'
      const blocks = textToContentBlocks(text, WORKSPACE)

      expect(blocks).toHaveLength(2)
      expect(blocks[0]).toEqual({ type: 'text', text: 'Here is your outfit:' })
      expect(blocks[1]).toMatchObject({
        type: 'image',
        url: '/files/images/outfit.png',
        alt: 'outfit',
      })
      expect(blocks[1].imageId).toBeDefined()
    })

    it('keeps markdown syntax as text when file does not exist', () => {
      const text = 'Check this: ![missing](images/nonexistent.png)'
      const blocks = textToContentBlocks(text, WORKSPACE)

      // Should be kept as text since file doesn't exist
      const allText = blocks.filter(b => b.type === 'text').map(b => b.text).join(' ')
      expect(allText).toContain('![missing](images/nonexistent.png)')
    })

    it('handles multiple images in one text', () => {
      createFile('images/a.png')
      createFile('images/b.jpg')
      const text = 'First ![a](images/a.png) then ![b](images/b.jpg) done'
      const blocks = textToContentBlocks(text, WORKSPACE)

      const imageBlocks = blocks.filter(b => b.type === 'image')
      expect(imageBlocks).toHaveLength(2)
      expect(imageBlocks[0].url).toBe('/files/images/a.png')
      expect(imageBlocks[1].url).toBe('/files/images/b.jpg')
    })

    it('strips workspace/ prefix from paths', () => {
      createFile('images/test.png')
      const text = '![test](workspace/images/test.png)'
      const blocks = textToContentBlocks(text, WORKSPACE)

      const imageBlock = blocks.find(b => b.type === 'image')
      expect(imageBlock).toBeDefined()
      expect(imageBlock!.url).toBe('/files/images/test.png')
    })

    it('handles all supported image extensions', () => {
      const extensions = ['png', 'jpg', 'jpeg', 'webp', 'gif']
      for (const ext of extensions) {
        createFile(`images/test.${ext}`)
      }

      for (const ext of extensions) {
        const text = `![img](images/test.${ext})`
        const blocks = textToContentBlocks(text, WORKSPACE)
        const imageBlock = blocks.find(b => b.type === 'image')
        expect(imageBlock, `should detect .${ext}`).toBeDefined()
        expect(imageBlock!.url).toBe(`/files/images/test.${ext}`)
      }
    })

    it('generates stable imageId from file path', () => {
      createFile('images/my-outfit.png')
      const blocks1 = textToContentBlocks('![](images/my-outfit.png)', WORKSPACE)
      const blocks2 = textToContentBlocks('![](images/my-outfit.png)', WORKSPACE)

      const id1 = blocks1.find(b => b.type === 'image')?.imageId
      const id2 = blocks2.find(b => b.type === 'image')?.imageId
      expect(id1).toBe(id2)
    })

    it('sets alt to undefined when empty', () => {
      createFile('images/test.png')
      const blocks = textToContentBlocks('![](images/test.png)', WORKSPACE)
      const imageBlock = blocks.find(b => b.type === 'image')
      expect(imageBlock!.alt).toBeUndefined()
    })

    it('preserves text before and after image', () => {
      createFile('images/x.png')
      const text = 'Before image ![x](images/x.png) after image'
      const blocks = textToContentBlocks(text, WORKSPACE)

      expect(blocks[0]).toMatchObject({ type: 'text', text: 'Before image' })
      expect(blocks[1]).toMatchObject({ type: 'image' })
      expect(blocks[2]).toMatchObject({ type: 'text', text: 'after image' })
    })
  })

  describe('bare file path detection', () => {
    it('detects bare image paths in known directories', () => {
      createFile('images/look.png')
      const text = 'I generated an image: images/look.png'
      const blocks = textToContentBlocks(text, WORKSPACE)

      const imageBlock = blocks.find(b => b.type === 'image')
      expect(imageBlock).toBeDefined()
      expect(imageBlock!.url).toBe('/files/images/look.png')
    })

    it('detects bare paths in closet/ directory', () => {
      createFile('closet/shirt.jpg')
      const text = 'Found: closet/shirt.jpg in your closet'
      const blocks = textToContentBlocks(text, WORKSPACE)

      const imageBlock = blocks.find(b => b.type === 'image')
      expect(imageBlock).toBeDefined()
      expect(imageBlock!.url).toBe('/files/closet/shirt.jpg')
    })

    it('detects bare paths in looks/ directory', () => {
      createFile('looks/casual.webp')
      const text = 'Your look: looks/casual.webp'
      const blocks = textToContentBlocks(text, WORKSPACE)

      const imageBlock = blocks.find(b => b.type === 'image')
      expect(imageBlock).toBeDefined()
      expect(imageBlock!.url).toBe('/files/looks/casual.webp')
    })

    it('detects workspace/-prefixed bare paths', () => {
      createFile('images/foo.png')
      const text = 'File at workspace/images/foo.png here'
      const blocks = textToContentBlocks(text, WORKSPACE)

      const imageBlock = blocks.find(b => b.type === 'image')
      expect(imageBlock).toBeDefined()
      expect(imageBlock!.url).toBe('/files/images/foo.png')
    })

    it('does not detect bare paths when markdown images are found', () => {
      createFile('images/md.png')
      createFile('images/bare.png')
      // markdown image takes priority — bare path detection is skipped
      const text = '![md](images/md.png) also images/bare.png'
      const blocks = textToContentBlocks(text, WORKSPACE)

      const imageBlocks = blocks.filter(b => b.type === 'image')
      expect(imageBlocks).toHaveLength(1)
      expect(imageBlocks[0].url).toBe('/files/images/md.png')
    })

    it('ignores bare paths to non-existent files', () => {
      const text = 'Path images/missing.png does not exist'
      const blocks = textToContentBlocks(text, WORKSPACE)

      expect(blocks.every(b => b.type === 'text')).toBe(true)
    })

    it('uses filename as alt text for bare paths', () => {
      createFile('images/summer-outfit.png')
      const text = 'Check images/summer-outfit.png'
      const blocks = textToContentBlocks(text, WORKSPACE)

      const imageBlock = blocks.find(b => b.type === 'image')
      expect(imageBlock!.alt).toBe('summer-outfit')
    })
  })
})

// ── cleanupBlocks ──

describe('cleanupBlocks', () => {
  it('removes empty text blocks', () => {
    const blocks: ParsedContentBlock[] = [
      { type: 'text', text: '' },
      { type: 'text', text: 'hello' },
      { type: 'text', text: '  ' },
    ]
    const result = cleanupBlocks(blocks)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('hello')
  })

  it('strips orphaned bold markers', () => {
    const blocks: ParsedContentBlock[] = [
      { type: 'text', text: '**\nsome text\n**' },
    ]
    const result = cleanupBlocks(blocks)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('some text')
  })

  it('preserves image blocks unchanged', () => {
    const blocks: ParsedContentBlock[] = [
      { type: 'image', url: '/files/test.png', imageId: 'img-test' },
    ]
    const result = cleanupBlocks(blocks)
    expect(result).toEqual(blocks)
  })

  it('handles mixed text and image blocks', () => {
    const blocks: ParsedContentBlock[] = [
      { type: 'text', text: 'intro' },
      { type: 'image', url: '/files/a.png', imageId: 'img-a' },
      { type: 'text', text: '' },
      { type: 'text', text: 'outro' },
    ]
    const result = cleanupBlocks(blocks)
    expect(result).toHaveLength(3)
    expect(result[0].text).toBe('intro')
    expect(result[1].type).toBe('image')
    expect(result[2].text).toBe('outro')
  })
})

// ── parseJsonlMessages ──

describe('parseJsonlMessages', () => {
  function jsonl(...lines: any[]): string {
    return lines.map(l => JSON.stringify(l)).join('\n')
  }

  it('extracts user messages', () => {
    const content = jsonl({
      type: 'message',
      id: '1',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    })
    const messages = parseJsonlMessages(content, WORKSPACE)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].text).toBe('Hello')
  })

  it('extracts assistant messages', () => {
    const content = jsonl({
      type: 'message',
      id: '2',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there!' }],
      },
    })
    const messages = parseJsonlMessages(content, WORKSPACE)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('assistant')
    expect(messages[0].text).toBe('Hi there!')
  })

  it('skips non-message entries', () => {
    const content = jsonl(
      { type: 'event', data: 'something' },
      { type: 'message', id: '1', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'log', level: 'info' },
    )
    const messages = parseJsonlMessages(content, WORKSPACE)
    expect(messages).toHaveLength(1)
  })

  it('skips thinking blocks', () => {
    const content = jsonl({
      type: 'message',
      id: '1',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think...' },
          { type: 'text', text: 'Here is my answer' },
        ],
      },
    })
    const messages = parseJsonlMessages(content, WORKSPACE)
    expect(messages).toHaveLength(1)
    expect(messages[0].text).toBe('Here is my answer')
  })

  it('skips toolCall and toolResult entries', () => {
    const content = jsonl(
      { type: 'message', id: '1', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'search' }] } },
      { type: 'message', id: '2', message: { role: 'toolResult', content: [{ type: 'text', text: 'result' }] } },
      { type: 'message', id: '3', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } },
    )
    const messages = parseJsonlMessages(content, WORKSPACE)
    // First message has only toolCall (no text) → skipped
    // Second has role=toolResult → skipped
    // Third has text → included
    expect(messages).toHaveLength(1)
    expect(messages[0].text).toBe('Done')
  })

  it('concatenates multiple text blocks', () => {
    const content = jsonl({
      type: 'message',
      id: '1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
        ],
      },
    })
    const messages = parseJsonlMessages(content, WORKSPACE)
    expect(messages).toHaveLength(1)
    expect(messages[0].text).toContain('Part 1')
    expect(messages[0].text).toContain('Part 2')
  })

  it('skips messages with only whitespace text', () => {
    const content = jsonl({
      type: 'message',
      id: '1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '   ' }],
      },
    })
    const messages = parseJsonlMessages(content, WORKSPACE)
    expect(messages).toHaveLength(0)
  })

  it('skips messages with no content', () => {
    const content = jsonl({
      type: 'message',
      id: '1',
      message: { role: 'assistant' },
    })
    const messages = parseJsonlMessages(content, WORKSPACE)
    expect(messages).toHaveLength(0)
  })

  it('handles malformed JSON lines gracefully', () => {
    const content = 'not json\n{"type":"message","id":"1","message":{"role":"user","content":[{"type":"text","text":"ok"}]}}\n{broken'
    const messages = parseJsonlMessages(content, WORKSPACE)
    expect(messages).toHaveLength(1)
    expect(messages[0].text).toBe('ok')
  })

  it('handles empty content', () => {
    const messages = parseJsonlMessages('', WORKSPACE)
    expect(messages).toHaveLength(0)
  })

  it('detects images in message text', () => {
    createFile('images/outfit.png')
    const content = jsonl({
      type: 'message',
      id: '1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Here: ![outfit](images/outfit.png)' }],
      },
    })
    const messages = parseJsonlMessages(content, WORKSPACE)
    expect(messages).toHaveLength(1)
    const imageBlock = messages[0].content.find(b => b.type === 'image')
    expect(imageBlock).toBeDefined()
    expect(imageBlock!.url).toBe('/files/images/outfit.png')
  })

  it('handles non-array content (single block)', () => {
    const content = jsonl({
      type: 'message',
      id: '1',
      message: {
        role: 'user',
        content: { type: 'text', text: 'single block' },
      },
    })
    const messages = parseJsonlMessages(content, WORKSPACE)
    expect(messages).toHaveLength(1)
    expect(messages[0].text).toBe('single block')
  })

  it('preserves message order', () => {
    const content = jsonl(
      { type: 'message', id: '1', message: { role: 'user', content: [{ type: 'text', text: 'Q1' }] } },
      { type: 'message', id: '2', message: { role: 'assistant', content: [{ type: 'text', text: 'A1' }] } },
      { type: 'message', id: '3', message: { role: 'user', content: [{ type: 'text', text: 'Q2' }] } },
    )
    const messages = parseJsonlMessages(content, WORKSPACE)
    expect(messages).toHaveLength(3)
    expect(messages.map(m => m.text)).toEqual(['Q1', 'A1', 'Q2'])
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
  })
})

// ── Regex patterns ──

describe('IMAGE_RE', () => {
  it('matches markdown image syntax', () => {
    const tests = [
      { input: '![alt](path/file.png)', match: true },
      { input: '![](images/test.jpg)', match: true },
      { input: '![desc](closet/item.jpeg)', match: true },
      { input: '![](test.webp)', match: true },
      { input: '![](test.gif)', match: true },
      { input: '![](test.txt)', match: false },
      { input: '![](test.pdf)', match: false },
      { input: 'not an image', match: false },
    ]

    for (const { input, match } of tests) {
      // Reset lastIndex for global regex
      IMAGE_RE.lastIndex = 0
      expect(IMAGE_RE.test(input), `"${input}" should ${match ? '' : 'not '}match`).toBe(match)
    }
  })
})

describe('BARE_PATH_RE', () => {
  it('matches bare paths in known directories', () => {
    const tests = [
      { input: ' images/file.png ', match: true },
      { input: ' closet/item.jpg ', match: true },
      { input: ' looks/outfit.webp ', match: true },
      { input: ' workspace/images/file.png ', match: true },
      { input: ' random/file.png ', match: false },
      { input: ' images/file.txt ', match: false },
    ]

    for (const { input, match } of tests) {
      BARE_PATH_RE.lastIndex = 0
      expect(BARE_PATH_RE.test(input), `"${input}" should ${match ? '' : 'not '}match`).toBe(match)
    }
  })
})
