/**
 * Dual-lane token tracking for when wet proxy is disabled.
 *
 * Lane A (SDK): Real-time usage from Claude SDK `assistant` message events.
 * Lane B (JSONL): Near-real-time verification from session JSONL file tailing.
 *
 * When both lanes report data for the same turn, we cross-check totals
 * and log a warning if they diverge by more than 1000 tokens.
 *
 * Primary consumer: query.ts context fill logic when WET_DISABLED=1.
 */

import { getContextWindow } from "./pricing";

export interface TokenSnapshot {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  totalContext: number;
  timestamp: number;
  source: "sdk" | "jsonl";
}

export interface RawUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

function buildSnapshot(usage: RawUsage, source: "sdk" | "jsonl"): TokenSnapshot {
  const inputTokens = usage.input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;

  return {
    inputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    outputTokens,
    totalContext: inputTokens + cacheReadTokens + cacheCreationTokens,
    timestamp: Date.now(),
    source,
  };
}

export class SessionTokens {
  private sdkLatest: TokenSnapshot | null = null;
  private jsonlLatest: TokenSnapshot | null = null;
  private model: string;

  constructor(model: string) {
    this.model = model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  updateFromSDK(usage: RawUsage): void {
    this.sdkLatest = buildSnapshot(usage, "sdk");
    console.debug(
      `[session-tokens] SDK lane: ${this.sdkLatest.totalContext} context tokens`
    );
    this.checkDivergenceInternal();
  }

  updateFromJSONL(usage: RawUsage): void {
    this.jsonlLatest = buildSnapshot(usage, "jsonl");
    console.debug(
      `[session-tokens] JSONL lane: ${this.jsonlLatest.totalContext} context tokens`
    );
    this.checkDivergenceInternal();
  }

  /**
   * Primary getter — prefers SDK (lower latency), falls back to JSONL.
   */
  getLatest(): TokenSnapshot | null {
    return this.sdkLatest ?? this.jsonlLatest;
  }

  /**
   * Context fill percentage using the model's known context window.
   */
  getContextPercent(): number {
    const latest = this.getLatest();
    if (!latest) return 0;

    const window = getContextWindow(this.model);
    return window > 0 ? (latest.totalContext / window) * 100 : 0;
  }

  /**
   * Context window size for current model.
   */
  getContextWindow(): number {
    return getContextWindow(this.model);
  }

  /**
   * Returns both lane snapshots for /context display transparency.
   */
  getBothLanes(): { sdk: TokenSnapshot | null; jsonl: TokenSnapshot | null } {
    return { sdk: this.sdkLatest, jsonl: this.jsonlLatest };
  }

  /**
   * Cross-check: returns divergence info if both lanes have data.
   */
  checkDivergence(): { divergent: boolean; delta: number } | null {
    if (!this.sdkLatest || !this.jsonlLatest) return null;

    const delta = Math.abs(this.sdkLatest.totalContext - this.jsonlLatest.totalContext);
    return { divergent: delta > 1000, delta };
  }

  /**
   * Reset all tracking (e.g., on /start session reset).
   */
  reset(): void {
    this.sdkLatest = null;
    this.jsonlLatest = null;
  }

  private checkDivergenceInternal(): void {
    const result = this.checkDivergence();
    if (result?.divergent) {
      console.warn(
        `[session-tokens] Lane divergence: SDK=${this.sdkLatest!.totalContext}, JSONL=${this.jsonlLatest!.totalContext}, delta=${result.delta}`
      );
    }
  }
}

// Singleton instance — shared across claude.ts, jsonl-watcher.ts, query.ts
let instance: SessionTokens | null = null;

export function getSessionTokens(model?: string): SessionTokens {
  if (!instance) {
    instance = new SessionTokens(model ?? "claude-opus-4-6");
  } else if (model) {
    instance.setModel(model);
  }
  return instance;
}

export function resetSessionTokens(): void {
  if (instance) {
    instance.reset();
  }
}
