/**
 * Token pricing per model (costs in cents per 1M tokens).
 */
export const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  // Google
  'gemini-3.1-flash-lite-preview': { inputPer1M: 2.5, outputPer1M: 10 },
  'gemini-2.5-flash-lite': { inputPer1M: 2.5, outputPer1M: 10 },
  'gemini-2.5-flash': { inputPer1M: 15, outputPer1M: 60 },
  'gemini-2.5-pro': { inputPer1M: 125, outputPer1M: 500 },
  'gemini-3-flash-preview': { inputPer1M: 15, outputPer1M: 60 },
  'gemini-flash-lite-latest': { inputPer1M: 2.5, outputPer1M: 10 },
  // Moonshot
  'kimi-k2.5': { inputPer1M: 60, outputPer1M: 300 },
  'k2p5': { inputPer1M: 60, outputPer1M: 300 },
  // Anthropic
  'claude-haiku-4-5-20251001': { inputPer1M: 80, outputPer1M: 400 },
  'claude-haiku-4-5': { inputPer1M: 80, outputPer1M: 400 },
  'claude-opus-4-6': { inputPer1M: 1500, outputPer1M: 7500 },
  // OpenAI
  'gpt-4.1-nano': { inputPer1M: 10, outputPer1M: 40 },
  'gpt-4.1-mini': { inputPer1M: 40, outputPer1M: 160 },
  'gpt-4.1': { inputPer1M: 200, outputPer1M: 800 },
  'gpt-5-nano': { inputPer1M: 15, outputPer1M: 60 },
  'gpt-5-mini': { inputPer1M: 30, outputPer1M: 120 },
}

/**
 * Calculate the cost in cents for a given model and token usage.
 */
export function calculateCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model]
  if (!pricing) return 0
  return (inputTokens * pricing.inputPer1M + outputTokens * pricing.outputPer1M) / 1_000_000
}
