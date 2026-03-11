/**
 * Token pricing per model (costs in cents per 1M tokens).
 */
export const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  // Google
  'gemini-3.1-flash-lite': { inputPer1M: 25, outputPer1M: 150 },
  // Moonshot
  'kimi-k2.5': { inputPer1M: 60, outputPer1M: 300 },
  // Anthropic
  'claude-haiku-4-5-20251001': { inputPer1M: 80, outputPer1M: 400 },
  'claude-haiku-4-5': { inputPer1M: 80, outputPer1M: 400 },
  'claude-opus-4-6': { inputPer1M: 1500, outputPer1M: 7500 },
}

/**
 * Calculate the cost in cents for a given model and token usage.
 */
export function calculateCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model]
  if (!pricing) return 0
  return (inputTokens * pricing.inputPer1M + outputTokens * pricing.outputPer1M) / 1_000_000
}
