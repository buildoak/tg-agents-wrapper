import { describe, expect, mock, test } from "bun:test";

process.env.TGBOT_API_KEY = "test-token-for-tests";

const { processQuery } = await import("./query");
const { SessionStore } = await import("../session/store");

describe("processQuery codex model selection", () => {
  test("passes the selected codex model and keeps reasoning effort separate", async () => {
    const seenConfigs: Array<{ model?: string; reasoningEffort?: string }> = [];
    const adapter = {
      name: "codex" as const,
      getSessionId: () => "thread-1",
      interrupt: async () => false,
      async *query(config: { model?: string; reasoningEffort?: string }) {
        seenConfigs.push({
          model: config.model,
          reasoningEffort: config.reasoningEffort,
        });
        yield { type: "text.done" as const, text: "ok" };
        yield { type: "done" as const, fullText: "ok" };
      },
    };

    const sendMessage = mock(async () => ({ message_id: 1 }));
    const store = new SessionStore("/tmp/tg-agents-wrapper-query-test.json");
    const session = store.get(123);
    session.engine = "codex";
    session.codexModel = "gpt-5.4-mini";
    session.reasoningEffort = "xhigh";

    await processQuery({
      adapter,
      session,
      prompt: "hello",
      userId: 123,
      chatId: 456,
      bot: {
        api: {
          sendMessage,
          sendChatAction: mock(async () => undefined),
          deleteMessage: mock(async () => undefined),
        },
      } as any,
      store,
      workingDir: process.cwd(),
      ttsConfig: {} as any,
    });

    expect(seenConfigs).toEqual([
      {
        model: "gpt-5.4-mini",
        reasoningEffort: "xhigh",
      },
    ]);
  });
});
