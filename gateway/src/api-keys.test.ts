import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

// Mock db module before importing api-keys
vi.mock('./db.js', () => {
  const mockFrom = vi.fn()
  return {
    getSupabase: vi.fn(() => ({ from: mockFrom })),
    __mockFrom: mockFrom,
  }
})

// Mock log module
vi.mock('./log.js', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

// Mock config for db.js transitive import
vi.mock('./config.js', () => ({
  config: {
    supabase: { url: 'https://test.supabase.co', secretKey: 'test' },
  },
}))

describe('api-keys', () => {
  let lookupByApiKey: typeof import('./api-keys.js').lookupByApiKey
  let getSupabase: any

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('./api-keys.js')
    lookupByApiKey = mod.lookupByApiKey
    const dbMod = await import('./db.js')
    getSupabase = dbMod.getSupabase
  })

  describe('lookupByApiKey', () => {
    it('returns null for keys without meios_ prefix', async () => {
      const result = await lookupByApiKey('sk_not_meios_key')
      expect(result).toBeNull()
    })

    it('returns null for empty string', async () => {
      const result = await lookupByApiKey('')
      expect(result).toBeNull()
    })

    it('returns user when key is valid and not expired', async () => {
      const key = 'meios_abc123def456abc123def456abc123de'
      const keyHash = createHash('sha256').update(key).digest('hex')

      const mockSingle = vi.fn().mockResolvedValue({
        data: { user_id: 'user-1', expires_at: null },
        error: null,
      })
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle })
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq })
      // For the lookup call and the fire-and-forget update call
      const mockUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ then: vi.fn((cb: any) => cb()) }) })
      const mockFrom = vi.fn()
        .mockReturnValueOnce({ select: mockSelect })   // lookup
        .mockReturnValueOnce({ update: mockUpdate })    // update last_used

      ;(getSupabase as any).mockReturnValue({ from: mockFrom })

      const result = await lookupByApiKey(key)
      expect(result).toEqual({ id: 'user-1' })
      expect(mockFrom).toHaveBeenCalledWith('api_keys')
      expect(mockSelect).toHaveBeenCalledWith('user_id, expires_at')
      expect(mockEq).toHaveBeenCalledWith('key_hash', keyHash)
    })

    it('returns null when key is expired', async () => {
      const key = 'meios_abc123def456abc123def456abc123de'
      const pastDate = new Date(Date.now() - 86400000).toISOString()

      const mockSingle = vi.fn().mockResolvedValue({
        data: { user_id: 'user-1', expires_at: pastDate },
        error: null,
      })
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle })
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq })
      const mockFrom = vi.fn().mockReturnValue({ select: mockSelect })

      ;(getSupabase as any).mockReturnValue({ from: mockFrom })

      const result = await lookupByApiKey(key)
      expect(result).toBeNull()
    })

    it('returns null when database returns error', async () => {
      const key = 'meios_abc123def456abc123def456abc123de'

      const mockSingle = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'not found' },
      })
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle })
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq })
      const mockFrom = vi.fn().mockReturnValue({ select: mockSelect })

      ;(getSupabase as any).mockReturnValue({ from: mockFrom })

      const result = await lookupByApiKey(key)
      expect(result).toBeNull()
    })
  })
})
