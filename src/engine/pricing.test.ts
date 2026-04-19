import { describe, test, expect } from "bun:test";
import {
  calculateCost,
  getContextWindow,
  MODEL_PRICING,
  MODEL_CONTEXT_WINDOWS,
  type UsageForPricing,
} from "./pricing";

describe("calculateCost", () => {
  test("returns correct cost for claude-opus-4-6 with all token types", () => {
    const usage: UsageForPricing = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    };
    // input: 15 + output: 75 + cached: 1.875 + cacheCreation: 18.75 = 110.625
    const cost = calculateCost("claude-opus-4-6", usage);
    expect(cost).toBeCloseTo(110.625, 5);
  });

  test("returns correct cost for claude-sonnet-4-6", () => {
    const usage: UsageForPricing = {
      inputTokens: 500_000,
      outputTokens: 200_000,
      cachedInputTokens: 300_000,
      cacheCreationInputTokens: 0,
    };
    // input: 0.5 * 3 = 1.5, output: 0.2 * 15 = 3, cached: 0.3 * 0.375 = 0.1125
    const cost = calculateCost("claude-sonnet-4-6", usage);
    expect(cost).toBeCloseTo(4.6125, 5);
  });

  test("returns correct cost for codex-1", () => {
    const usage: UsageForPricing = {
      inputTokens: 100_000,
      outputTokens: 50_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    // input: 0.1 * 2 = 0.2, output: 0.05 * 8 = 0.4
    const cost = calculateCost("codex-1", usage);
    expect(cost).toBeCloseTo(0.6, 5);
  });

  test("returns correct cost for claude-opus-4-6[1m]", () => {
    const usage: UsageForPricing = {
      inputTokens: 0,
      outputTokens: 100_000,
      cachedInputTokens: 900_000,
      cacheCreationInputTokens: 0,
    };
    // input: 0, output: 0.1 * 75 = 7.5, cached: 0.9 * 1.875 = 1.6875
    const cost = calculateCost("claude-opus-4-6[1m]", usage);
    expect(cost).toBeCloseTo(9.1875, 5);
  });

  test("returns zero cost for zero tokens", () => {
    const usage: UsageForPricing = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const cost = calculateCost("claude-opus-4-6", usage);
    expect(cost).toBe(0);
  });

  test("returns null for unknown model", () => {
    const usage: UsageForPricing = {
      inputTokens: 1000,
      outputTokens: 1000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const cost = calculateCost("totally-unknown-model", usage);
    expect(cost).toBeNull();
  });

  test("handles case-insensitive model lookup", () => {
    const usage: UsageForPricing = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const cost = calculateCost("Claude-Opus-4-6", usage);
    // lookupModel normalizes to lowercase, but keys in MODEL_PRICING are lowercase
    // "claude-opus-4-6" is in the table, so exact match should work
    expect(cost).toBeCloseTo(15, 5);
  });

  test("handles model name with leading/trailing whitespace", () => {
    const usage: UsageForPricing = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const cost = calculateCost("  claude-opus-4-6  ", usage);
    expect(cost).toBeCloseTo(15, 5);
  });

  test("prefix matching works for model variants", () => {
    // A model string starting with a known model name should match via prefix
    const usage: UsageForPricing = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const cost = calculateCost("gpt-4.1-turbo-preview", usage);
    // Should match "gpt-4.1" pricing: input = 1M * 2/1M = 2
    expect(cost).toBeCloseTo(2, 5);
  });
});

describe("getContextWindow", () => {
  test("returns correct window for claude-opus-4-6[1m]", () => {
    expect(getContextWindow("claude-opus-4-6[1m]")).toBe(1_000_000);
  });

  test("returns correct window for claude-opus-4-6", () => {
    expect(getContextWindow("claude-opus-4-6")).toBe(1_000_000);
  });

  test("returns correct window for claude-sonnet-4-6", () => {
    expect(getContextWindow("claude-sonnet-4-6")).toBe(1_000_000);
  });

  test("returns correct window for codex-1", () => {
    expect(getContextWindow("codex-1")).toBe(192_000);
  });

  test("returns correct window for gpt-4.1", () => {
    expect(getContextWindow("gpt-4.1")).toBe(1_000_000);
  });

  test("returns correct window for gpt-5.4", () => {
    expect(getContextWindow("gpt-5.4")).toBe(1_050_000);
  });

  test("returns default 200000 for unknown model", () => {
    expect(getContextWindow("unknown-model-xyz")).toBe(200_000);
  });

  test("handles case-insensitive lookup", () => {
    expect(getContextWindow("Claude-Sonnet-4-6")).toBe(1_000_000);
  });

  test("prefix match works for context window", () => {
    expect(getContextWindow("gpt-4.1-some-variant")).toBe(1_000_000);
  });
});

describe("MODEL_PRICING table", () => {
  test("all entries have non-negative values", () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.inputPer1M).toBeGreaterThanOrEqual(0);
      expect(pricing.outputPer1M).toBeGreaterThanOrEqual(0);
      expect(pricing.cachedInputPer1M).toBeGreaterThanOrEqual(0);
      expect(pricing.cacheCreationPer1M).toBeGreaterThanOrEqual(0);
    }
  });

  test("output pricing is always >= input pricing", () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.outputPer1M).toBeGreaterThanOrEqual(pricing.inputPer1M);
    }
  });

  test("cached input pricing is always <= regular input pricing", () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.cachedInputPer1M).toBeLessThanOrEqual(pricing.inputPer1M);
    }
  });
});

describe("MODEL_CONTEXT_WINDOWS table", () => {
  test("all windows are positive integers", () => {
    for (const [model, window] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      expect(window).toBeGreaterThan(0);
      expect(Number.isInteger(window)).toBe(true);
    }
  });
});
