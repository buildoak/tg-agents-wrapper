export type EngineType = "claude" | "codex";
export type VoiceMode = "off" | "cloud" | "local";

export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;
  costUSD: number;
}

export type ModelUsage = Record<string, ModelUsageEntry>;

export interface ImageData {
  buffer: Buffer;
  mimeType: string;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Session {
  engine: EngineType;

  sessionId?: string;
  lastActivity: number;
  chatId?: number;

  abortController?: AbortController;
  isQueryActive: boolean;
  wasInterruptedByNewMessage: boolean;
  isResetting: boolean;

  voiceMode: VoiceMode;
  voiceId: string;

  /** Reasoning effort for both engines. Claude maps to thinking budget, Codex to reasoning_effort. */
  reasoningEffort?: ReasoningEffort;
  showThinking?: boolean;

  lastModelUsage?: ModelUsage;
  totalCostUSD: number;
  lastInputTokens: number;
  cumulativeInputTokens: number;

  batchDelayMs: number;
}

export interface MessageBuffer {
  messages: import("./bus/bus").InboundMessage[];
  timeout: ReturnType<typeof setTimeout> | null;
  chatId: number;
  userId: number;
}

export interface PersistedSession {
  engine: EngineType;
  sessionId: string;
  lastActivity: number;
  voiceMode?: VoiceMode;
  voiceId?: string;
  reasoningEffort?: ReasoningEffort;
  showThinking?: boolean;
  lastModelUsage?: ModelUsage;
  totalCostUSD?: number;
  lastInputTokens?: number;
  cumulativeInputTokens?: number;
  batchDelayMs?: number;
}

export function normalizeVoiceMode(
  value: unknown,
  _engine: EngineType = "claude"
): VoiceMode {
  if (value === true) return "cloud";
  if (value === false || value === null || value === undefined) return "off";
  if (value === "off" || value === "cloud" || value === "local") return value;
  if (value === "claude" || value === "codex") return "off";
  return "off";
}
