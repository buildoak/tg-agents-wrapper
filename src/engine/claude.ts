import {
  query as runClaudeQuery,
  type Query as ClaudeQuery,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  categorize,
  type ClaudeEngineConfig,
  type EngineAdapter,
  type NormalizedEvent,
  type QueryConfig,
  type ToolCategory,
} from "./interface";
import {
  CLAUDE_STREAM_IDLE_TIMEOUT_MS,
  CLAUDE_STREAM_MAX_SESSIONS,
  WET_DISABLED,
} from "../config";
import { isWetHealthy } from "../integrations/wet";
import { startJsonlWatcher } from "./jsonl-watcher";
import { getSessionTokens, type RawUsage } from "./session-tokens";
import { formatToolInput } from "../util/markdown";

// ─── Utility Helpers ─────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getRecordValue<T>(
  record: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is T
): T | undefined {
  const value = record[key];
  return guard(value) ? value : undefined;
}

function extractSessionId(event: unknown): string | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  const direct = asString(event.session_id);
  if (direct) {
    return direct;
  }

  if (isRecord(event.message)) {
    const nested = asString(event.message.session_id);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function buildImageTextPrompt(
  text: string,
  images: QueryConfig["images"]
): string {
  if (!images || images.length === 0) {
    return text;
  }

  const imageLines = images.map(
    (img) => `Image saved to: ${img.filePath}`
  );
  return `${text}\n\n${imageLines.join("\n")}`;
}

// ─── Async Message Queue ─────────────────────────────────────────

class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private buf: T[] = [];
  private waiters: Array<{
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: unknown) => void;
  }> = [];
  private closed = false;
  private failure?: unknown;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
    } else {
      this.buf.push(value);
    }
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) {
      waiter.resolve({ value: undefined as unknown as T, done: true });
    }
    this.waiters = [];
  }

  fail(error: unknown): void {
    this.closed = true;
    this.failure = error;
    for (const waiter of this.waiters) {
      waiter.reject(error);
    }
    this.waiters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buf.length > 0) {
          return Promise.resolve({ value: this.buf.shift()!, done: false });
        }
        if (this.failure) {
          return Promise.reject(this.failure);
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

// ─── Per-Turn State ──────────────────────────────────────────────

interface TurnState {
  fullText: string;
  activeTools: Map<string, string>;
  toolCounter: number;
  emittedSessionStarted: boolean;
}

function createTurnState(): TurnState {
  return {
    fullText: "",
    activeTools: new Map(),
    toolCounter: 0,
    emittedSessionStarted: false,
  };
}

// ─── Turn Request ────────────────────────────────────────────────

interface ClaudeTurnRequest {
  turnId: string;
  config: QueryConfig;
  state: TurnState;
  pushEvent(event: NormalizedEvent): void;
  finish(fullText: string): void;
  fail(error: unknown): void;
}

// ─── Session Runtime ─────────────────────────────────────────────

interface ClaudeSessionRuntime {
  key: string;
  sessionId?: string;
  query: ClaudeQuery;
  input: AsyncMessageQueue<SDKUserMessage>;
  activeTurn?: ClaudeTurnRequest;
  pendingTurns: ClaudeTurnRequest[];
  readerTask: Promise<void>;
  lastActivityAt: number;
  isClosing: boolean;
  jsonlWatcherStarted: boolean;
}

// ─── Claude Adapter ──────────────────────────────────────────────

export class ClaudeAdapter implements EngineAdapter {
  readonly name = "claude" as const;

  private readonly runtimes = new Map<string, ClaudeSessionRuntime>();
  private readonly defaultModel: string;
  private readonly defaultWorkingDir: string;

  constructor(config: ClaudeEngineConfig) {
    this.defaultModel = config.model;
    this.defaultWorkingDir = config.workingDir;
  }

  getSessionId(): string | undefined {
    // Backward compat: return the first runtime's sessionId
    const first = this.runtimes.values().next().value as ClaudeSessionRuntime | undefined;
    return first?.sessionId;
  }

  resume(_sessionId: string): void {
    // No-op in streaming mode — persistent runtimes don't use resume
  }

  async interrupt(): Promise<boolean> {
    // Interrupt the first runtime's active query (backward compat for single-user)
    const first = this.runtimes.values().next().value as ClaudeSessionRuntime | undefined;
    if (!first?.query) {
      return false;
    }
    try {
      await first.query.interrupt();
      return true;
    } catch {
      return false;
    }
  }

  async disposeSession(runtimeKey: string): Promise<void> {
    const runtime = this.runtimes.get(runtimeKey);
    if (!runtime) return;
    await this.destroyRuntime(runtime);
  }

  async disposeIdleSessions(): Promise<void> {
    const now = Date.now();
    const toDispose: ClaudeSessionRuntime[] = [];
    for (const runtime of this.runtimes.values()) {
      if (!runtime.activeTurn && now - runtime.lastActivityAt > CLAUDE_STREAM_IDLE_TIMEOUT_MS) {
        toDispose.push(runtime);
      }
    }
    for (const runtime of toDispose) {
      console.log(`[claude] disposing idle runtime ${runtime.key} (idle ${Math.round((now - runtime.lastActivityAt) / 1000)}s)`);
      await this.destroyRuntime(runtime);
    }
  }

  async dispose(): Promise<void> {
    const all = [...this.runtimes.values()];
    for (const runtime of all) {
      await this.destroyRuntime(runtime);
    }
  }

  // ─── Runtime Lifecycle ───────────────────────────────────────

  private async destroyRuntime(runtime: ClaudeSessionRuntime): Promise<void> {
    if (runtime.isClosing) return;
    runtime.isClosing = true;
    this.runtimes.delete(runtime.key);

    // Fail active and pending turns
    if (runtime.activeTurn) {
      runtime.activeTurn.fail(new Error("Claude runtime disposed"));
      runtime.activeTurn = undefined;
    }
    for (const pending of runtime.pendingTurns) {
      pending.fail(new Error("Claude runtime disposed"));
    }
    runtime.pendingTurns = [];

    // Close input queue and terminate the query generator
    runtime.input.close();
    try {
      await runtime.query.return(undefined as unknown as void);
    } catch {
      // best-effort cleanup — query may already be done
    }
  }

  private buildCleanEnv(): Record<string, string | undefined> {
    const cleanEnv: Record<string, string | undefined> = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    cleanEnv.DISABLE_AUTO_COMPACT = "1";
    cleanEnv.ANTHROPIC_BETAS = "context-1m-2025-08-07";
    return cleanEnv;
  }

  private async resolveBaseUrl(cleanEnv: Record<string, string | undefined>): Promise<void> {
    if (WET_DISABLED) {
      delete cleanEnv.ANTHROPIC_BASE_URL;
    } else {
      const wetPort = process.env.WET_PORT?.trim();
      if (wetPort) {
        const healthy = await isWetHealthy();
        if (healthy) {
          cleanEnv.ANTHROPIC_BASE_URL = `http://localhost:${wetPort}`;
        } else {
          delete cleanEnv.ANTHROPIC_BASE_URL;
        }
      }
    }
  }

  private async getOrCreateRuntime(config: QueryConfig): Promise<ClaudeSessionRuntime> {
    const key = config.runtimeKey;
    const existing = this.runtimes.get(key);
    if (existing && !existing.isClosing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }

    // Enforce max sessions cap — evict idle runtimes first
    if (this.runtimes.size >= CLAUDE_STREAM_MAX_SESSIONS) {
      let leastActive: ClaudeSessionRuntime | undefined;
      for (const rt of this.runtimes.values()) {
        if (!rt.activeTurn && (!leastActive || rt.lastActivityAt < leastActive.lastActivityAt)) {
          leastActive = rt;
        }
      }
      if (leastActive) {
        console.log(`[claude] evicting idle runtime ${leastActive.key} to make room`);
        await this.destroyRuntime(leastActive);
      } else {
        throw new Error(`Claude streaming: max sessions (${CLAUDE_STREAM_MAX_SESSIONS}) reached, all busy`);
      }
    }

    const cleanEnv = this.buildCleanEnv();
    await this.resolveBaseUrl(cleanEnv);

    // SDK contract: effort: 'max' is Opus 4.6 only. Sonnet caps at 'high'.
    const resolvedModel = config.model ?? this.defaultModel;
    const maxLevel: 'high' | 'max' = resolvedModel.includes('opus') ? 'max' : 'high';
    const claudeEffort: 'low' | 'medium' | 'high' | 'max' = (() => {
      switch (config.reasoningEffort) {
        case "minimal":
        case "low":    return "low";
        case "medium": return "medium";
        case "high":   return "high";
        case "xhigh":
        case "max":    return maxLevel;
        default:       return "high";
      }
    })();

    const input = new AsyncMessageQueue<SDKUserMessage>();

    // If we have a previous sessionId (e.g. runtime was idle-disposed but the TG
    // session still holds the old session_id), resume it so the new subprocess
    // loads the prior conversation history instead of starting fresh.
    const resumeSessionId = config.sessionId;

    const queryInstance = runClaudeQuery({
      prompt: input,
      options: {
        model: resolvedModel,
        betas: ["context-1m-2025-08-07"],
        cwd: config.workingDir || this.defaultWorkingDir,
        env: cleanEnv,
        settingSources: ["user", "project"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        thinking: { type: 'adaptive' },
        effort: claudeEffort,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        // NO maxTurns — persistent process handles unlimited turns
      },
    });

    if (resumeSessionId) {
      console.log(`[claude] resuming session ${resumeSessionId.slice(0, 8)} in new runtime`);
    }

    const runtime: ClaudeSessionRuntime = {
      key,
      sessionId: resumeSessionId,
      query: queryInstance,
      input,
      pendingTurns: [],
      readerTask: Promise.resolve(),
      lastActivityAt: Date.now(),
      isClosing: false,
      jsonlWatcherStarted: false,
    };

    // Start the background reader loop
    runtime.readerTask = this.runReaderLoop(runtime);

    this.runtimes.set(key, runtime);
    console.log(`[claude] created streaming runtime for key=${key}${resumeSessionId ? ` (resuming ${resumeSessionId.slice(0, 8)})` : " (fresh session)"}`);
    return runtime;
  }

  // ─── Background Reader Loop ──────────────────────────────────

  private processClaudeEvent(
    event: unknown,
    runtime: ClaudeSessionRuntime,
    turnState: TurnState,
    config: QueryConfig,
  ): NormalizedEvent[] {
    const normalized: NormalizedEvent[] = [];
    const sessionId = extractSessionId(event);

    if (sessionId) {
      runtime.sessionId = sessionId;
      if (!turnState.emittedSessionStarted) {
        turnState.emittedSessionStarted = true;
        normalized.push({
          type: "session.started",
          sessionId,
          raw: event,
        });

        // Start JSONL watcher once per runtime (not per turn)
        if (WET_DISABLED && !runtime.jsonlWatcherStarted) {
          runtime.jsonlWatcherStarted = true;
          const cwd = config.workingDir || this.defaultWorkingDir;
          startJsonlWatcher(cwd, sessionId);
        }
      }
    }

    if (!isRecord(event)) {
      return normalized;
    }

    const eventType = asString(event.type);

    if (eventType === "assistant") {
      const message = getRecordValue(event, "message", isRecord);
      const content = message ? message.content : undefined;

      if (Array.isArray(content)) {
        for (const rawBlock of content) {
          if (!isRecord(rawBlock)) {
            continue;
          }

          const blockType = asString(rawBlock.type);
          if (blockType === "text") {
            const text = asString(rawBlock.text) ?? "";
            if (!text) {
              continue;
            }

            turnState.fullText += text;
            normalized.push({
              type: "text.delta",
              text,
              raw: event,
            });
            continue;
          }

          if (blockType === "tool_use") {
            const toolName = asString(rawBlock.name) ?? "tool";
            const input = getRecordValue(rawBlock, "input", isRecord) ?? {};
            const toolId = asString(rawBlock.id) ?? `tool-${Date.now()}-${turnState.toolCounter++}`;
            const toolCategory: ToolCategory = categorize(toolName);
            const preview = formatToolInput(toolName, input);

            turnState.activeTools.set(toolId, toolName);
            normalized.push({
              type: "tool.started",
              toolId,
              toolName,
              toolCategory,
              preview,
              raw: event,
            });
          }
        }
      }

      // Lane A: Extract per-API-call usage from assistant message events.
      if (WET_DISABLED && message) {
        const usage = getRecordValue(message, "usage", isRecord);
        if (usage) {
          const rawUsage: RawUsage = {
            input_tokens: asNumber(usage.input_tokens),
            cache_read_input_tokens: asNumber(usage.cache_read_input_tokens),
            cache_creation_input_tokens: asNumber(usage.cache_creation_input_tokens),
            output_tokens: asNumber(usage.output_tokens),
          };
          getSessionTokens(config.model ?? this.defaultModel).updateFromSDK(rawUsage);
        }
      }

      return normalized;
    }

    if (eventType === "user") {
      const message = getRecordValue(event, "message", isRecord);
      const content = message ? message.content : undefined;

      if (Array.isArray(content)) {
        let emittedToolResult = false;
        for (const rawBlock of content) {
          if (!isRecord(rawBlock) || asString(rawBlock.type) !== "tool_result") {
            continue;
          }

          const toolId = asString(rawBlock.tool_use_id) ?? turnState.activeTools.keys().next().value;
          if (!toolId) {
            continue;
          }

          const toolName = turnState.activeTools.get(toolId) ?? "tool";
          turnState.activeTools.delete(toolId);
          emittedToolResult = true;

          normalized.push({
            type: "tool.completed",
            toolId,
            toolName,
            success: true,
            raw: event,
          });
        }

        if (emittedToolResult) {
          return normalized;
        }
      }

      const fallbackId = turnState.activeTools.keys().next().value;
      if (fallbackId) {
        const fallbackName = turnState.activeTools.get(fallbackId) ?? "tool";
        turnState.activeTools.delete(fallbackId);
        normalized.push({
          type: "tool.completed",
          toolId: fallbackId,
          toolName: fallbackName,
          success: true,
          raw: event,
        });
      }

      return normalized;
    }

    if (eventType === "result") {
      const usage = getRecordValue(event, "usage", isRecord) ?? {};
      const modelUsage = getRecordValue(event, "modelUsage", isRecord) ?? {};

      const modelUsageEntries = Object.entries(modelUsage);
      const [modelName, firstUsageRaw] = modelUsageEntries[0] ?? [undefined, undefined];
      const firstUsage = isRecord(firstUsageRaw) ? firstUsageRaw : undefined;

      const inputTokens =
        asNumber(usage.input_tokens) ?? asNumber(firstUsage?.inputTokens) ?? 0;
      const outputTokens =
        asNumber(usage.output_tokens) ?? asNumber(firstUsage?.outputTokens) ?? 0;
      const cachedInputTokens =
        asNumber(usage.cache_read_input_tokens) ??
        asNumber(firstUsage?.cacheReadInputTokens) ??
        0;
      const cacheCreationInputTokens =
        asNumber(usage.cache_creation_input_tokens) ??
        asNumber(firstUsage?.cacheCreationInputTokens) ??
        0;
      const sdkContextWindow = asNumber(firstUsage?.contextWindow) ?? null;
      const contextWindowSize = sdkContextWindow;
      const costUSD =
        asNumber(event.total_cost_usd) ?? asNumber(firstUsage?.costUSD) ?? null;

      normalized.push({
        type: "usage",
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheCreationInputTokens,
        costUSD,
        contextWindowSize,
        model: asString(event.model) ?? modelName,
        raw: event,
      });

      const subtype = asString(event.subtype);
      const isErrorResult = subtype ? subtype !== "success" : Boolean(event.is_error);

      if (isErrorResult) {
        const errors = Array.isArray(event.errors) ? event.errors : [];
        const firstError = errors.find((value) => typeof value === "string");

        normalized.push({
          type: "error",
          message:
            firstError ??
            asString(event.result) ??
            "Claude query failed during execution.",
          fatal: true,
          raw: event,
        });
      }

      return normalized;
    }

    if (eventType === "system" && asString(event.subtype) === "task_notification") {
      const status = asString(event.status);
      if (
        status === "started" ||
        status === "completed" ||
        status === "failed" ||
        status === "stopped"
      ) {
        normalized.push({
          type: "task.notification",
          taskId: asString(event.task_id) ?? "unknown",
          status,
          summary: asString(event.summary),
          raw: event,
        });
      }
    }

    return normalized;
  }

  private async runReaderLoop(runtime: ClaudeSessionRuntime): Promise<void> {
    try {
      for await (const event of runtime.query) {
        if (runtime.isClosing) break;

        const turn = runtime.activeTurn;
        if (!turn) {
          // Stray event with no active turn — log and skip
          continue;
        }

        const normalized = this.processClaudeEvent(
          event,
          runtime,
          turn.state,
          turn.config,
        );

        for (const ev of normalized) {
          turn.pushEvent(ev);
        }

        // Check if this is a result event — marks turn completion
        if (isRecord(event) && asString(event.type) === "result") {
          turn.finish(turn.state.fullText);
          runtime.activeTurn = undefined;

          // Promote next pending turn
          const next = runtime.pendingTurns.shift();
          if (next) {
            runtime.activeTurn = next;
            // Signal the waiting turn that it's now active
            next.pushEvent({ type: "session.started", sessionId: runtime.sessionId ?? "" });
          }
        }
      }
    } catch (error) {
      console.error(`[claude] reader loop error for runtime ${runtime.key}:`, error);
      if (runtime.activeTurn) {
        runtime.activeTurn.fail(error);
        runtime.activeTurn = undefined;
      }
    } finally {
      // Reader exited — mark runtime as closing and clean up
      if (!runtime.isClosing) {
        console.log(`[claude] reader loop ended for runtime ${runtime.key}`);
        runtime.isClosing = true;
        this.runtimes.delete(runtime.key);

        // Fail any remaining pending turns
        for (const pending of runtime.pendingTurns) {
          pending.fail(new Error("Claude subprocess ended unexpectedly"));
        }
        runtime.pendingTurns = [];
      }
    }
  }

  // ─── Query (Turn-Level Entry Point) ──────────────────────────

  async *query(config: QueryConfig): AsyncGenerator<NormalizedEvent, void, void> {
    const runtime = await this.getOrCreateRuntime(config);
    runtime.lastActivityAt = Date.now();

    // Create a turn-scoped event channel
    const events: NormalizedEvent[] = [];
    let turnResolve: (() => void) | undefined;
    let turnDone = false;
    let turnError: unknown;

    const turnState = createTurnState();

    const turn: ClaudeTurnRequest = {
      turnId: crypto.randomUUID(),
      config,
      state: turnState,
      pushEvent(event: NormalizedEvent) {
        events.push(event);
        turnResolve?.();
        turnResolve = undefined;
      },
      finish(text: string) {
        turnState.fullText = text;
        turnDone = true;
        turnResolve?.();
        turnResolve = undefined;
      },
      fail(error: unknown) {
        turnError = error;
        turnDone = true;
        turnResolve?.();
        turnResolve = undefined;
      },
    };

    // Enqueue turn — only one active turn per runtime
    if (runtime.activeTurn) {
      runtime.pendingTurns.push(turn);
      // Wait until we become the active turn (signaled by first pushEvent or fail)
      await new Promise<void>((resolve, reject) => {
        const origPush = turn.pushEvent.bind(turn);
        turn.pushEvent = (event: NormalizedEvent) => {
          turn.pushEvent = origPush; // restore original
          origPush(event);
          resolve();
        };
        const origFail = turn.fail.bind(turn);
        turn.fail = (error: unknown) => {
          turn.fail = origFail;
          origFail(error);
          reject(error);
        };
      });
    } else {
      runtime.activeTurn = turn;
    }

    // Build and push the SDKUserMessage into the persistent input queue
    const userMessage: SDKUserMessage = {
      type: "user",
      message: {
        role: "user",
        content: buildImageTextPrompt(config.prompt, config.images),
      },
      parent_tool_use_id: null,
      session_id: runtime.sessionId ?? "",
    };
    runtime.input.push(userMessage);

    // Yield events until the turn is done
    try {
      while (!turnDone) {
        if (events.length > 0) {
          while (events.length > 0) {
            yield events.shift()!;
          }
        } else {
          await new Promise<void>((resolve) => {
            turnResolve = resolve;
          });
        }
      }

      // Flush any remaining events
      while (events.length > 0) {
        yield events.shift()!;
      }

      if (turnError) {
        throw turnError;
      }

      yield {
        type: "text.done",
        text: turnState.fullText,
      };

      yield {
        type: "done",
        fullText: turnState.fullText,
      };
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        fatal: true,
      };

      yield {
        type: "done",
        fullText: turnState.fullText,
      };
    }
  }
}
