// src/engine/interface.ts

// ─── Normalized Event Types ────────────────────────────────────

export type NormalizedEventType =
  | "session.started"
  | "text.delta"
  | "text.done"
  | "tool.started"
  | "tool.updated"
  | "tool.completed"
  | "usage"
  | "error"
  | "task.notification"
  | "context.warning"
  | "reasoning"
  | "done";

export interface BaseEvent {
  type: NormalizedEventType;
  /** Raw engine event for debugging (not consumed by query handler) */
  raw?: unknown;
}

export interface SessionStartedEvent extends BaseEvent {
  type: "session.started";
  sessionId: string;
}

export interface TextDeltaEvent extends BaseEvent {
  type: "text.delta";
  /** A chunk of text — may be followed by more text.delta events */
  text: string;
}

export interface TextDoneEvent extends BaseEvent {
  type: "text.done";
  /** Final text — no more text coming for this message */
  text: string;
}

export interface ToolStartedEvent extends BaseEvent {
  type: "tool.started";
  toolId: string;
  toolName: string;
  toolCategory: ToolCategory;
  /** Human-readable preview for status message */
  preview: string;
}

export interface ToolUpdatedEvent extends BaseEvent {
  type: "tool.updated";
  toolId: string;
  toolName: string;
  output?: string;
}

export interface ToolCompletedEvent extends BaseEvent {
  type: "tool.completed";
  toolId: string;
  toolName: string;
  success: boolean;
}

/**
 * Token usage from the engine. All three input fields are ADDITIVE (not overlapping):
 *   total context fill = inputTokens + cachedInputTokens + cacheCreationInputTokens
 *
 * Claude API semantics (ref: Anthropic prompt caching docs):
 *   input_tokens             = non-cached tokens (after last cache breakpoint)
 *   cache_read_input_tokens  = tokens served from cache (cheap, still occupy context)
 *   cache_creation_input_tokens = tokens written to cache this turn (premium rate)
 */
export interface UsageEvent extends BaseEvent {
  type: "usage";
  /** Non-cached input tokens (after last cache breakpoint). Does NOT include cache reads. */
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from prompt cache (cache_read_input_tokens in Claude API). */
  cachedInputTokens: number;
  /** Tokens written to cache for the first time this turn. Codex sets to 0. */
  cacheCreationInputTokens: number;
  /** null if engine doesn't report cost directly (Codex) */
  costUSD: number | null;
  /** null if unknown (Codex — use pricing table lookup) */
  contextWindowSize: number | null;
  /** Model identifier for cost calculation */
  model?: string;
}

export interface ErrorEvent extends BaseEvent {
  type: "error";
  message: string;
  /** If true, the turn is unrecoverable */
  fatal: boolean;
}

export interface TaskNotificationEvent extends BaseEvent {
  type: "task.notification";
  taskId: string;
  status: "completed" | "failed" | "stopped" | "started";
  summary?: string;
}

export interface ContextWarningEvent extends BaseEvent {
  type: "context.warning";
  /**
   * "threshold" — cumulative tokens exceeded a threshold
   */
  trigger: "threshold";
  /** For threshold trigger: the percentage that was exceeded */
  percentage?: number;
}

export interface ReasoningEvent extends BaseEvent {
  type: "reasoning";
  text: string;
}

export interface DoneEvent extends BaseEvent {
  type: "done";
  /** Complete response text (all text events concatenated) */
  fullText: string;
}

export type NormalizedEvent =
  | SessionStartedEvent
  | TextDeltaEvent
  | TextDoneEvent
  | ToolStartedEvent
  | ToolUpdatedEvent
  | ToolCompletedEvent
  | UsageEvent
  | ErrorEvent
  | TaskNotificationEvent
  | ContextWarningEvent
  | ReasoningEvent
  | DoneEvent;

// ─── Tool Categories ───────────────────────────────────────────

export type ToolCategory =
  | "bash" // Command execution
  | "read" // File reading (Read, Grep, Glob)
  | "write" // File writing (Edit, Write)
  | "search" // Web search
  | "agent" // Sub-agent / task spawning
  | "mcp" // MCP tool calls
  | "other"; // Anything else

/**
 * Map tool names to categories for status icon selection.
 * Claude-only — Codex maps item types to categories directly (see Section 3 notes).
 */
export function categorize(toolName: string): ToolCategory {
  switch (toolName) {
    case "Bash":
      return "bash";
    case "Read":
    case "Grep":
    case "Glob":
      return "read";
    case "Edit":
    case "Write":
      return "write";
    case "WebSearch":
    case "WebFetch":
      return "search";
    case "Task":
    case "Agent":
      return "agent";
    default:
      if (toolName.startsWith("mcp__")) return "mcp";
      return "other";
  }
}

// ─── Image Input ───────────────────────────────────────────────

export interface EngineImageInput {
  /** Absolute path to image on disk */
  filePath: string;
  /** MIME type (image/jpeg, image/png, etc.) */
  mimeType: string;
  /** Base64-encoded data. Pre-computed by the photo handler.
   *  Claude adapter uses this. Codex adapter ignores it (uses filePath). */
  base64Data: string;
}

// ─── Query Config ──────────────────────────────────────────────

export interface QueryConfig {
  prompt: string;
  images?: EngineImageInput[];
  /** Resume existing session/thread. undefined = new session. */
  sessionId?: string;
  workingDir: string;
  abortSignal: AbortSignal;
  /** Model override (default: engine's configured model) */
  model?: string;
  /** Reasoning effort override. Codex: maps to reasoning_effort. Claude: maps to thinking budget. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

// ─── Engine Adapter ────────────────────────────────────────────

export interface EngineAdapter {
  readonly name: "claude" | "codex";

  /**
   * Start processing. Called once at startup.
   */
  start?(): Promise<void>;

  /**
   * Stream normalized events for a query.
   * One-way stream: engine emits events, consumer reads. No callbacks.
   * Yields events until the turn completes, then yields a DoneEvent.
   * Handles stale session recovery internally (yields a fresh session.started if recovered).
   */
  query(config: QueryConfig): AsyncGenerator<NormalizedEvent, void, void>;

  /**
   * Graceful interrupt — stop processing but preserve transcript.
   * Returns true if the engine supports and executed the interrupt.
   * Returns false if not supported (caller should use abort signal).
   * Codex always returns false (SIGTERM kills child process — no graceful interrupt).
   */
  interrupt(): Promise<boolean>;

  /**
   * Resume a session after reset.
   */
  resume?(sessionId: string): void;

  /**
   * Get the current session/thread ID, or undefined if no session active.
   */
  getSessionId(): string | undefined;

  /**
   * Clean up resources. Called on graceful shutdown.
   */
  dispose?(): Promise<void>;
}

// ─── Engine Config (for constructors) ──────────────────────────

export interface ClaudeEngineConfig {
  model: string; // default: "claude-opus-4-6"
  workingDir: string;
}

export interface CodexEngineConfig {
  model: string; // default: "codex-1"
  workingDir: string;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  networkAccess: boolean;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
