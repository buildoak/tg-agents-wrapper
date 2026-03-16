import {
  Codex,
  type CommandExecutionItem,
  type FileChangeItem,
  type McpToolCallItem,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type UserInput,
  type WebSearchItem,
} from "@openai/codex-sdk";

import { calculateCost, getContextWindow } from "./pricing";
import {
  type CodexEngineConfig,
  type EngineAdapter,
  type NormalizedEvent,
  type QueryConfig,
  type ToolCategory,
} from "./interface";

type CodexAdapterConfig = CodexEngineConfig & {
  apiKey?: string;
};

type CodexToolItem = CommandExecutionItem | FileChangeItem | McpToolCallItem | WebSearchItem;
type CodexEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
type CodexClientOptions = NonNullable<ConstructorParameters<typeof Codex>[0]>;

// Codex doesn't support "max" — map to "xhigh" (its highest level)
function mapCodexEffort(effort?: string): CodexEffort | undefined {
  switch (effort) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return effort;
    case "max":
      return "xhigh";
    default:
      return undefined;
  }
}

function createUserInput(prompt: string, images?: QueryConfig["images"]): UserInput[] {
  const input: UserInput[] = [{ type: "text", text: prompt }];

  if (!images || images.length === 0) {
    return input;
  }

  for (const image of images) {
    input.push({
      type: "local_image",
      path: image.filePath,
    });
  }

  return input;
}

function isToolItem(item: ThreadItem): item is CodexToolItem {
  return (
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "mcp_tool_call" ||
    item.type === "web_search"
  );
}

function mapToolCategory(item: CodexToolItem): ToolCategory {
  // Codex uses typed item events, so we map directly instead of using categorize().
  if (item.type === "command_execution") return "bash";
  if (item.type === "file_change") return "write";
  if (item.type === "mcp_tool_call") return "mcp";
  return "search";
}

function toolName(item: CodexToolItem): string {
  if (item.type === "command_execution") return "command_execution";
  if (item.type === "file_change") return "file_change";
  if (item.type === "mcp_tool_call") return "mcp_tool_call";
  return "web_search";
}

function toolPreview(item: CodexToolItem): string {
  if (item.type === "command_execution") {
    return `Command:\n${item.command}`;
  }

  if (item.type === "file_change") {
    if (item.changes.length === 0) {
      return "Applying file changes";
    }

    const parts = item.changes
      .slice(0, 3)
      .map((change) => `${change.kind}: ${change.path}`);
    const extra =
      item.changes.length > 3 ? ` (+${item.changes.length - 3} more)` : "";

    return `Files: ${parts.join(", ")}${extra}`;
  }

  if (item.type === "mcp_tool_call") {
    return `MCP: ${item.server}.${item.tool}`;
  }

  return `Search: ${item.query}`;
}

function toolSucceeded(item: CodexToolItem): boolean {
  if (item.type === "command_execution") return item.status === "completed";
  if (item.type === "file_change") return item.status === "completed";
  if (item.type === "mcp_tool_call") return item.status === "completed";
  return true;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CodexAdapter implements EngineAdapter {
  readonly name = "codex" as const;

  private readonly codex: Codex;
  private readonly defaultModel: string;
  private readonly defaultWorkingDir: string;
  private readonly sandboxMode: CodexEngineConfig["sandboxMode"];
  private readonly networkAccess: boolean;
  private readonly reasoningEffort: CodexEffort;
  private currentThreadId?: string;

  constructor(config: CodexAdapterConfig) {
    // Pass parent env so subprocesses (gaal, agent-mux) inherit API keys.
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
    const codexOpts: CodexClientOptions = { env };
    if (config.apiKey) codexOpts.apiKey = config.apiKey;
    this.codex = new Codex(codexOpts);

    this.defaultModel = config.model;
    this.defaultWorkingDir = config.workingDir;
    this.sandboxMode = config.sandboxMode ?? "workspace-write";
    this.networkAccess = config.networkAccess ?? true;
    this.reasoningEffort = mapCodexEffort(config.reasoningEffort) ?? "medium";
  }

  getSessionId(): string | undefined {
    return this.currentThreadId;
  }

  resume(sessionId: string): void {
    this.currentThreadId = sessionId;
  }

  async interrupt(): Promise<boolean> {
    return false;
  }

  async *query(config: QueryConfig): AsyncGenerator<NormalizedEvent, void, void> {
    const model = config.model ?? this.defaultModel;
    const prompt = config.prompt;
    const input = createUserInput(prompt, config.images);
    const threadOptions: ThreadOptions = {
      model,
      workingDirectory: config.workingDir || this.defaultWorkingDir,
      sandboxMode: this.sandboxMode,
      modelReasoningEffort: mapCodexEffort(config.reasoningEffort) ?? this.reasoningEffort,
      networkAccessEnabled: this.networkAccess,
      approvalPolicy: "never",
    };

    let resumeThreadId = config.sessionId;
    let fullText = "";
    let emittedSessionStarted = false;

    const processThreadEvent = (event: ThreadEvent): NormalizedEvent[] => {
      const normalized: NormalizedEvent[] = [];

      if (event.type === "thread.started") {
        this.currentThreadId = event.thread_id;
        if (!emittedSessionStarted) {
          emittedSessionStarted = true;
          normalized.push({
            type: "session.started",
            sessionId: event.thread_id,
            raw: event,
          });
        }
        return normalized;
      }

      if (event.type === "turn.completed") {
        const inputTokens = event.usage.input_tokens;
        const outputTokens = event.usage.output_tokens;
        const cachedInputTokens = event.usage.cached_input_tokens;
        const usage = {
          inputTokens,
          outputTokens,
          cachedInputTokens,
          cacheCreationInputTokens: 0,
        };

        normalized.push({
          type: "usage",
          inputTokens,
          outputTokens,
          cachedInputTokens,
          cacheCreationInputTokens: 0,
          costUSD: calculateCost(model, usage),
          contextWindowSize: getContextWindow(model),
          model,
          raw: event,
        });
        return normalized;
      }

      if (event.type === "turn.failed") {
        normalized.push({
          type: "error",
          message: event.error.message || "Codex turn failed.",
          fatal: true,
          raw: event,
        });
        return normalized;
      }

      if (event.type === "error") {
        normalized.push({
          type: "error",
          message: event.message || "Codex stream error.",
          fatal: true,
          raw: event,
        });
        return normalized;
      }

      if (event.type !== "item.started" && event.type !== "item.completed") {
        return normalized;
      }

      const { item } = event;

      if (item.type === "agent_message") {
        if (event.type === "item.completed" && item.text) {
          fullText += item.text;
          normalized.push({
            type: "text.done",
            text: fullText,
            raw: event,
          });
        }
        return normalized;
      }

      if (item.type === "reasoning" && event.type === "item.completed" && item.text) {
        normalized.push({
          type: "reasoning",
          text: item.text,
          raw: event,
        });
        return normalized;
      }

      if (item.type === "error" && event.type === "item.completed") {
        normalized.push({
          type: "error",
          message: item.message,
          fatal: true,
          raw: event,
        });
        return normalized;
      }

      if (!isToolItem(item)) {
        return normalized;
      }

      const toolId = item.id;
      const resolvedToolName = toolName(item);
      const toolCategory = mapToolCategory(item);

      if (event.type === "item.started") {
        normalized.push({
          type: "tool.started",
          toolId,
          toolName: resolvedToolName,
          toolCategory,
          preview: toolPreview(item),
          raw: event,
        });
        return normalized;
      }

      normalized.push({
        type: "tool.completed",
        toolId,
        toolName: resolvedToolName,
        success: toolSucceeded(item),
        raw: event,
      });
      return normalized;
    };

    const startStream = async (
      threadId?: string
    ): Promise<{
      thread: Thread;
      iterator: AsyncIterator<ThreadEvent, void, void>;
    }> => {
      const thread = threadId
        ? this.codex.resumeThread(threadId, threadOptions)
        : this.codex.startThread(threadOptions);

      if (thread.id) {
        this.currentThreadId = thread.id;
      }

      const streamedTurn = await thread.runStreamed(input, {
        signal: config.abortSignal,
      });

      return {
        thread,
        iterator: streamedTurn.events[Symbol.asyncIterator](),
      };
    };

    try {
      let thread: Thread;
      let iterator: AsyncIterator<ThreadEvent, void, void>;

      try {
        ({ thread, iterator } = await startStream(resumeThreadId));
      } catch (error) {
        if (!resumeThreadId) {
          throw error;
        }

        resumeThreadId = undefined;
        ({ thread, iterator } = await startStream(undefined));
      }

      let firstResult: IteratorResult<ThreadEvent, void>;

      try {
        firstResult = await iterator.next();
      } catch (error) {
        if (!resumeThreadId) {
          throw error;
        }

        resumeThreadId = undefined;
        ({ thread, iterator } = await startStream(undefined));
        firstResult = await iterator.next();
      }

      if (!firstResult.done) {
        for (const event of processThreadEvent(firstResult.value)) {
          yield event;
        }
      }

      for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        for (const event of processThreadEvent(next.value)) {
          yield event;
        }
      }

      if (thread.id) {
        this.currentThreadId = thread.id;
      }

      yield {
        type: "done",
        fullText,
      };
    } catch (error) {
      yield {
        type: "error",
        message: toErrorMessage(error),
        fatal: true,
      };

      yield {
        type: "done",
        fullText,
      };
    }
  }
}
