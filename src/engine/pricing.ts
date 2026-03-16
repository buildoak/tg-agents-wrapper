export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M: number;
  cacheCreationPer1M: number;
}

/**
 * All three input fields are additive (not overlapping).
 * See UsageEvent in interface.ts for full semantics.
 */
export interface UsageForPricing {
  /** Non-cached input tokens (after last cache breakpoint). */
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from prompt cache (discounted rate). */
  cachedInputTokens: number;
  /** Tokens written to cache this turn (premium rate). */
  cacheCreationInputTokens: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6": {
    inputPer1M: 15,
    outputPer1M: 75,
    cachedInputPer1M: 1.875,
    cacheCreationPer1M: 18.75,
  },
  "claude-sonnet-4-6": {
    inputPer1M: 3,
    outputPer1M: 15,
    cachedInputPer1M: 0.375,
    cacheCreationPer1M: 3.75,
  },
  "codex-1": {
    inputPer1M: 2,
    outputPer1M: 8,
    cachedInputPer1M: 0.5,
    cacheCreationPer1M: 0,
  },
  "gpt-4.1": {
    inputPer1M: 2,
    outputPer1M: 8,
    cachedInputPer1M: 0.5,
    cacheCreationPer1M: 0,
  },
  "gpt-5.4": {
    inputPer1M: 2.5,
    outputPer1M: 15,
    cachedInputPer1M: 0.25,
    cacheCreationPer1M: 0,
  },
};

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-6": 1000000,
  "claude-sonnet-4-6": 1000000,
  "codex-1": 192000,
  "gpt-4.1": 1000000,
  "gpt-5.4": 1050000,
};

function lookupModel<T>(table: Record<string, T>, model: string): T | undefined {
  const normalized = model.trim().toLowerCase();
  if (table[normalized]) {
    return table[normalized];
  }

  const match = Object.entries(table).find(([name]) => normalized.startsWith(name));
  return match?.[1];
}

export function calculateCost(model: string, usage: UsageForPricing): number | null {
  const pricing = lookupModel(MODEL_PRICING, model);
  if (!pricing) return null;

  // Claude API: input_tokens is ONLY non-cached tokens (after last cache breakpoint).
  // cache_read and cache_creation are separate fields, priced at their own rates.
  // No subtraction needed — inputTokens is already the non-cached portion.
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPer1M;
  const cachedCost = (usage.cachedInputTokens / 1_000_000) * pricing.cachedInputPer1M;
  const cacheCreationCost =
    (usage.cacheCreationInputTokens / 1_000_000) * pricing.cacheCreationPer1M;

  return inputCost + outputCost + cachedCost + cacheCreationCost;
}

export function getContextWindow(model: string): number {
  const contextWindow = lookupModel(MODEL_CONTEXT_WINDOWS, model);
  return contextWindow ?? 200000;
}
