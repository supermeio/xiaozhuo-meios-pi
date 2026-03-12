import { getSupabase } from './db.js'
import { log, logError } from './log.js'

function blog(msg: string, data?: Record<string, unknown>) { log('billing', msg, data) }

/**
 * Ensure user has a plan for the current period. If not, assign 'free'.
 *
 * Note: Budget checking and usage recording are now handled by LiteLLM
 * via virtual key budgets and built-in cost tracking.
 */
export async function ensureUserPlan(userId: string): Promise<void> {
  const supabase = getSupabase()
  const now = new Date()
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  // Check if plan exists for current period
  const { data } = await supabase
    .from('user_plans')
    .select('id')
    .eq('user_id', userId)
    .gte('period_end', now.toISOString())
    .limit(1)
    .single()

  if (data) return // already has a plan

  // Assign free plan
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
  const { error } = await supabase
    .from('user_plans')
    .insert({
      user_id: userId,
      plan_id: 'free',
      period_start: periodStart,
      period_end: periodEnd,
    })

  if (error) {
    logError('billing', 'ensureUserPlan failed', error, { userId })
  } else {
    blog('free plan assigned', { userId })
  }
}
