import { getSupabase } from './db.js'
import { log, logError } from './log.js'

function blog(msg: string, data?: Record<string, unknown>) { log('billing', msg, data) }

export interface BudgetCheck {
  allowed: boolean
  budget_cents: number
  used_cents: number
  remaining_cents?: number
  reason?: string
}

/**
 * Check if user has remaining budget for current billing period.
 */
export async function checkBudget(userId: string): Promise<BudgetCheck> {
  const { data, error } = await getSupabase().rpc('check_budget', { p_user_id: userId })
  if (error) {
    logError('billing', 'check_budget failed', error, { userId })
    // Fail open: allow the request if billing check fails
    return { allowed: true, budget_cents: 0, used_cents: 0 }
  }
  return data as BudgetCheck
}

/**
 * Record a usage event (fire-and-forget, non-blocking).
 */
export async function recordUsage(params: {
  sandboxId: string
  userId: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  costCents: number
}): Promise<void> {
  const { error } = await getSupabase().rpc('record_usage', {
    p_sandbox_id: params.sandboxId,
    p_user_id: params.userId,
    p_provider: params.provider,
    p_model: params.model,
    p_input_tokens: params.inputTokens,
    p_output_tokens: params.outputTokens,
    p_cost_cents: params.costCents,
  })
  if (error) {
    logError('billing', 'record_usage failed', error, params)
  } else {
    blog('usage recorded', { model: params.model, cost: params.costCents })
  }
}

/**
 * Ensure user has a plan for the current period. If not, assign 'free'.
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
