import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies
vi.mock('./db.js', () => ({
  getSupabase: vi.fn(),
}))

vi.mock('./log.js', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('./config.js', () => ({
  config: {
    supabase: { url: 'https://test.supabase.co', secretKey: 'test' },
  },
}))

describe('billing', () => {
  let ensureUserPlan: typeof import('./billing.js').ensureUserPlan
  let getSupabase: any

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('./billing.js')
    ensureUserPlan = mod.ensureUserPlan
    const dbMod = await import('./db.js')
    getSupabase = dbMod.getSupabase
  })

  it('does nothing when user already has a plan for the current period', async () => {
    const mockSingle = vi.fn().mockResolvedValue({ data: { id: 'plan-1' }, error: null })
    const mockLimit = vi.fn().mockReturnValue({ single: mockSingle })
    const mockGte = vi.fn().mockReturnValue({ limit: mockLimit })
    const mockEq = vi.fn().mockReturnValue({ gte: mockGte })
    const mockSelect = vi.fn().mockReturnValue({ eq: mockEq })
    const mockFrom = vi.fn().mockReturnValue({ select: mockSelect })
    ;(getSupabase as any).mockReturnValue({ from: mockFrom })

    await ensureUserPlan('user-1')

    // Should have queried but NOT inserted
    expect(mockFrom).toHaveBeenCalledWith('user_plans')
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('inserts a free plan when user has no plan for the current period', async () => {
    // First call: query returns no data
    const mockSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const mockLimit = vi.fn().mockReturnValue({ single: mockSingle })
    const mockGte = vi.fn().mockReturnValue({ limit: mockLimit })
    const mockEq = vi.fn().mockReturnValue({ gte: mockGte })
    const mockSelect = vi.fn().mockReturnValue({ eq: mockEq })

    // Second call: insert
    const mockInsert = vi.fn().mockResolvedValue({ error: null })

    const mockFrom = vi.fn()
      .mockReturnValueOnce({ select: mockSelect })  // query
      .mockReturnValueOnce({ insert: mockInsert })   // insert

    ;(getSupabase as any).mockReturnValue({ from: mockFrom })

    await ensureUserPlan('user-1')

    expect(mockFrom).toHaveBeenCalledTimes(2)
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        plan_id: 'free',
      })
    )
  })
})
