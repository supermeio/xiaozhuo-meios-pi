import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// We need to import the tools and set the workspace root for testing
import {
  setWorkspaceRoot,
  saveClothingTool,
  listClosetTool,
  getClothingTool,
  suggestOutfitTool,
  generateImageTool,
  wardrobeTools,
} from './tools.js'

describe('tools', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'meios-test-'))
    setWorkspaceRoot(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('wardrobeTools export', () => {
    it('exports all 9 tools', () => {
      expect(wardrobeTools).toHaveLength(9)
    })

    it('each tool has required fields', () => {
      for (const tool of wardrobeTools) {
        expect(tool.name).toBeTruthy()
        expect(tool.label).toBeTruthy()
        expect(tool.description).toBeTruthy()
        expect(tool.parameters).toBeTruthy()
        expect(typeof tool.execute).toBe('function')
      }
    })

    it('has the expected tool names', () => {
      const names = wardrobeTools.map(t => t.name)
      expect(names).toEqual([
        'save_clothing',
        'list_closet',
        'get_clothing',
        'suggest_outfit',
        'generate_image',
        'create_collection',
        'add_to_collection',
        'list_collections',
        'view_collection',
      ])
    })
  })

  describe('save_clothing', () => {
    it('saves a clothing item as markdown', async () => {
      const result = await saveClothingTool.execute(
        'call-1',
        { id: 'white-shirt', name: '白色衬衫', category: '上装', color: '白色' },
        new AbortController().signal,
        () => {},
        undefined as any,
      )

      expect(result.content[0].text).toContain('白色衬衫')
      expect(result.content[0].text).toContain('已保存')

      const filePath = join(tempDir, 'closet', 'white-shirt.md')
      expect(existsSync(filePath)).toBe(true)

      const content = readFileSync(filePath, 'utf-8')
      expect(content).toContain('# 白色衬衫')
      expect(content).toContain('**类别**: 上装')
      expect(content).toContain('**颜色**: 白色')
    })

    it('includes optional fields when provided', async () => {
      await saveClothingTool.execute(
        'call-2',
        {
          id: 'gucci-jacket',
          name: 'Gucci夹克',
          category: '外套',
          color: '黑色',
          brand: 'Gucci',
          season: '秋冬',
          occasions: ['约会', '派对'],
          notes: '很贵',
        },
        new AbortController().signal,
        () => {},
        undefined as any,
      )

      const content = readFileSync(join(tempDir, 'closet', 'gucci-jacket.md'), 'utf-8')
      expect(content).toContain('**品牌**: Gucci')
      expect(content).toContain('**季节**: 秋冬')
      expect(content).toContain('**场景**: 约会、派对')
      expect(content).toContain('**备注**: 很贵')
    })

    it('rejects invalid clothing IDs', async () => {
      const result = await saveClothingTool.execute(
        'call-3',
        { id: 'INVALID ID!', name: 'Test', category: '上装', color: '白' },
        new AbortController().signal,
        () => {},
        undefined as any,
      )

      expect(result.content[0].text).toContain('Invalid clothing ID')
    })

    it('rejects IDs starting with a hyphen', async () => {
      const result = await saveClothingTool.execute(
        'call-4',
        { id: '-bad-id', name: 'Test', category: '上装', color: '白' },
        new AbortController().signal,
        () => {},
        undefined as any,
      )

      expect(result.content[0].text).toContain('Invalid clothing ID')
    })
  })

  describe('list_closet', () => {
    it('returns empty message when closet directory does not exist', async () => {
      const result = await listClosetTool.execute(
        'call-1',
        {},
        new AbortController().signal,
        () => {},
        undefined as any,
      )

      expect(result.content[0].text).toContain('衣橱是空的')
    })

    it('lists saved clothing items', async () => {
      // Save two items first
      const closetDir = join(tempDir, 'closet')
      mkdirSync(closetDir, { recursive: true })
      writeFileSync(join(closetDir, 'white-shirt.md'), '# 白色衬衫\n\n- **类别**: 上装\n- **颜色**: 白色\n')
      writeFileSync(join(closetDir, 'black-pants.md'), '# 黑色西裤\n\n- **类别**: 下装\n- **颜色**: 黑色\n')

      const result = await listClosetTool.execute(
        'call-2',
        {},
        new AbortController().signal,
        () => {},
        undefined as any,
      )

      expect(result.content[0].text).toContain('2 件')
      expect(result.content[0].text).toContain('白色衬衫')
      expect(result.content[0].text).toContain('黑色西裤')
    })

    it('filters by category', async () => {
      const closetDir = join(tempDir, 'closet')
      mkdirSync(closetDir, { recursive: true })
      writeFileSync(join(closetDir, 'white-shirt.md'), '# 白色衬衫\n\n- **类别**: 上装\n- **颜色**: 白色\n')
      writeFileSync(join(closetDir, 'black-pants.md'), '# 黑色西裤\n\n- **类别**: 下装\n- **颜色**: 黑色\n')

      const result = await listClosetTool.execute(
        'call-3',
        { category: '上装' },
        new AbortController().signal,
        () => {},
        undefined as any,
      )

      expect(result.content[0].text).toContain('1 件')
      expect(result.content[0].text).toContain('白色衬衫')
      expect(result.content[0].text).not.toContain('黑色西裤')
    })
  })

  describe('get_clothing', () => {
    it('returns clothing details when item exists', async () => {
      const closetDir = join(tempDir, 'closet')
      mkdirSync(closetDir, { recursive: true })
      writeFileSync(join(closetDir, 'white-shirt.md'), '# 白色衬衫\n\n- **类别**: 上装\n')

      const result = await getClothingTool.execute(
        'call-1',
        { id: 'white-shirt' },
        new AbortController().signal,
        () => {},
        undefined as any,
      )

      expect(result.content[0].text).toContain('白色衬衫')
      expect(result.content[0].text).toContain('上装')
    })

    it('returns not-found message when item does not exist', async () => {
      const result = await getClothingTool.execute(
        'call-2',
        { id: 'nonexistent' },
        new AbortController().signal,
        () => {},
        undefined as any,
      )

      expect(result.content[0].text).toContain('找不到衣物')
    })

    it('rejects invalid IDs', async () => {
      const result = await getClothingTool.execute(
        'call-3',
        { id: 'BAD ID!' },
        new AbortController().signal,
        () => {},
        undefined as any,
      )

      expect(result.content[0].text).toContain('Invalid clothing ID')
    })
  })

  describe('suggest_outfit', () => {
    it('returns empty closet message when no clothes exist', async () => {
      const result = await suggestOutfitTool.execute(
        'call-1',
        { occasion: '约会' },
        new AbortController().signal,
        () => {},
        undefined as any,
      )

      expect(result.content[0].text).toContain('衣橱是空的')
    })

    it('returns context with closet contents and request details', async () => {
      const closetDir = join(tempDir, 'closet')
      mkdirSync(closetDir, { recursive: true })
      writeFileSync(join(closetDir, 'white-shirt.md'), '# 白色衬衫\n\n- **类别**: 上装\n')

      const result = await suggestOutfitTool.execute(
        'call-2',
        { occasion: '约会', weather: '晴天25度', preferences: '想穿裙子' },
        new AbortController().signal,
        () => {},
        undefined as any,
      )

      const text = result.content[0].text
      expect(text).toContain('约会')
      expect(text).toContain('晴天25度')
      expect(text).toContain('想穿裙子')
      expect(text).toContain('白色衬衫')
    })
  })

  describe('generate_image', () => {
    it('rejects invalid filenames', async () => {
      const result = await generateImageTool.execute(
        'call-1',
        { prompt: 'test', filename: 'BAD NAME!' },
        new AbortController().signal,
        () => {},
        undefined as any,
      )

      expect(result.content[0].text).toContain('Invalid filename')
    })

    it('returns error when OPENAI_BASE_URL is not set', async () => {
      const origBase = process.env.OPENAI_BASE_URL
      const origKey = process.env.OPENAI_API_KEY
      delete process.env.OPENAI_BASE_URL
      delete process.env.OPENAI_API_KEY

      const result = await generateImageTool.execute(
        'call-2',
        { prompt: 'test image', filename: 'test-image' },
        new AbortController().signal,
        () => {},
        undefined as any,
      )

      expect(result.content[0].text).toContain('not available')

      // Restore
      if (origBase) process.env.OPENAI_BASE_URL = origBase
      if (origKey) process.env.OPENAI_API_KEY = origKey
    })
  })
})
