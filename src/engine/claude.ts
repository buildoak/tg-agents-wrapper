import {
  query as runClaudeQuery,
  type Query as ClaudeQuery,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  categorize,
  type ClaudeEngineConfig,
  type EngineAdapter,
  type EngineImageInput,
  type NormalizedEvent,
  type QueryConfig,
  type ToolCategory,
} from "./interface";
import { isWetHealthy } from "../integrations/wet";
import { formatToolInput } from "../util/markdown";

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

function isStaleSessionError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes("exit") ||
    message.includes("exited with code") ||
    message.includes("session") ||
    message.includes("enoent") ||
    message.includes("spawn")
  );
}

function createImagePrompt(
  text: string,
  images: EngineImageInput[],
  sessionId?: string
): AsyncGenerator<SDKUserMessage, void, void> {
  return (async function* imagePromptGenerator() {
    const content: Array<Record<string, unknown>> = [{ type: "text", text }];

    for (const image of images) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: image.mimeType,
          data: image.base64Data,
        },
      });
    }

    const payload: Record<string, unknown> = {
      type: "user",
      message: {
        role: "user",
        content,
      },
      parent_tool_use_id: null,
    };

    if (sessionId) {
      payload.session_id = sessionId;
    }

    yield payload as SDKUserMessage;
  })();
}

export class ClaudeAdapter implements EngineAdapter {
  readonly name = "claude" as const;

  private activeQuery?: ClaudeQuery;
  private currentSessionId?: string;
  private pendingSessionId?: string;
  private readonly defaultModel: string;
  private readonly defaultWorkingDir: string;

  constructor(config: ClaudeEngineConfig) {
    this.defaultModel = config.model;
    this.defaultWorkingDir = config.workingDir;
  }

  getSessionId(): string | undefined {
    return this.currentSessionId;
  }

  resume(sessionId: string): void {
    this.currentSessionId = sessionId;
    this.pendingSessionId = undefined;
  }

  async interrupt(): Promise<boolean> {
    if (!this.activeQuery) {
      return false;
    }

    try {
      await this.activeQuery.interrupt();
      return true;
    } catch {
      return false;
    }
  }

  async *query(config: QueryConfig): AsyncGenerator<NormalizedEvent, void, void> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort(config.abortSignal.reason);

    if (config.abortSignal.aborted) {
      abortController.abort(config.abortSignal.reason);
    } else {
      config.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanEnv: Record<string, string | undefined> = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.DISABLE_AUTO_COMPACT;

    // When wet proxy is available AND healthy, route Claude API calls through it.
    // Falls back to direct Anthropic if wet is down. Auto-recovers on next query.
    // Use process.env at runtime (not the imported constant) since startWetServe() sets it dynamically.
    const wetPort = process.env.WET_PORT?.trim();
    if (wetPort) {
      const healthy = await isWetHealthy();
      if (healthy) {
        cleanEnv.ANTHROPIC_BASE_URL = `http://localhost:${wetPort}/v1`;
      } else {
        delete cleanEnv.ANTHROPIC_BASE_URL;
      }
    }

    const pendingEvents: NormalizedEvent[] = [];
    const activeTools = new Map<string, string>();
    let toolCounter = 0;
    let fullText = "";
    let emittedSessionStarted = false;

    this.currentSessionId = config.sessionId;
    this.pendingSessionId = undefined;

    const flushPendingEvents = function* () {
      while (pendingEvents.length > 0) {
        const event = pendingEvents.shift();
        if (event) {
          yield event;
        }
      }
    };

    const processClaudeEvent = (event: unknown): NormalizedEvent[] => {
      const normalized: NormalizedEvent[] = [];
      const sessionId = extractSessionId(event);

      if (sessionId) {
        this.pendingSessionId = sessionId;
        if (!emittedSessionStarted) {
          emittedSessionStarted = true;
          normalized.push({
            type: "session.started",
            sessionId,
            raw: event,
          });
        }
      }

      if (!isRecord(event)) {
        return normalized;
      }

      const eventType = asString(event.type);

      if (eventType === "assistant") {
        if (this.pendingSessionId) {
          this.currentSessionId = this.pendingSessionId;
          this.pendingSessionId = undefined;
        }

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

              fullText += text;
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
              const toolId = asString(rawBlock.id) ?? `tool-${Date.now()}-${toolCounter++}`;
              const toolCategory: ToolCategory = categorize(toolName);
              const preview = formatToolInput(toolName, input);

              activeTools.set(toolId, toolName);
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

            const toolId = asString(rawBlock.tool_use_id) ?? activeTools.keys().next().value;
            if (!toolId) {
              continue;
            }

            const toolName = activeTools.get(toolId) ?? "tool";
            activeTools.delete(toolId);
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

        const fallbackId = activeTools.keys().next().value;
        if (fallbackId) {
          const fallbackName = activeTools.get(fallbackId) ?? "tool";
          activeTools.delete(fallbackId);
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
        // Context window from SDK can be stale (200k instead of 1M for [1m] variant).
        // Prefer wet proxy value (set post-query), fall back to pricing.ts via getContextWindow().
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

        if (subtype === "success" && this.pendingSessionId) {
          this.currentSessionId = this.pendingSessionId;
          this.pendingSessionId = undefined;
        }

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
    };

    const buildPrompt = (): string | AsyncIterable<SDKUserMessage> => {
      const prompt = config.prompt;

      if (!config.images || config.images.length === 0) {
        return prompt;
      }

      return createImagePrompt(prompt, config.images, config.sessionId);
    };

    // Map our effort levels to Claude SDK effort levels
    const claudeEffort = (() => {
      switch (config.reasoningEffort) {
        case "minimal": return "low" as const;
        case "low": return "low" as const;
        case "medium": return "medium" as const;
        case "high": return "high" as const;
        case "xhigh": return "max" as const;
        case "max": return "max" as const;
        default: return undefined;
      }
    })();

    const createQuery = (resumeSessionId?: string): ClaudeQuery => {
      return runClaudeQuery({
        prompt: buildPrompt(),
        options: {
          model: config.model ?? this.defaultModel,
          cwd: config.workingDir || this.defaultWorkingDir,
          env: cleanEnv,
          settingSources: ["user", "project"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          ...(claudeEffort ? { effort: claudeEffort } : {}),
          resume: resumeSessionId,
          abortController,
        },
      });
    };

    try {
      let queryInstance = createQuery(config.sessionId);
      this.activeQuery = queryInstance;

      let iterator = queryInstance[Symbol.asyncIterator]();
      let firstResult: IteratorResult<unknown, void>;

      try {
        firstResult = await iterator.next();
      } catch (error) {
        const attemptedResume = config.sessionId;

        if (attemptedResume && isStaleSessionError(error)) {
          this.currentSessionId = undefined;
          this.pendingSessionId = undefined;
          pendingEvents.push({
            type: "error",
            message: "Session recovered - starting fresh.",
            fatal: false,
          });

          queryInstance = createQuery(undefined);
          this.activeQuery = queryInstance;
          iterator = queryInstance[Symbol.asyncIterator]();
          firstResult = await iterator.next();
        } else {
          throw error;
        }
      }

      for (const pending of flushPendingEvents()) {
        yield pending;
      }

      if (!firstResult.done) {
        for (const event of processClaudeEvent(firstResult.value)) {
          yield event;
        }
      }

      for (const pending of flushPendingEvents()) {
        yield pending;
      }

      for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        for (const pending of flushPendingEvents()) {
          yield pending;
        }

        for (const event of processClaudeEvent(next.value)) {
          yield event;
        }

        for (const pending of flushPendingEvents()) {
          yield pending;
        }
      }

      yield {
        type: "text.done",
        text: fullText,
      };

      yield {
        type: "done",
        fullText,
      };
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        fatal: true,
      };

      yield {
        type: "done",
        fullText,
      };
    } finally {
      this.activeQuery = undefined;
      this.pendingSessionId = undefined;
      config.abortSignal.removeEventListener("abort", onAbort);
    }
  }
}
