import { describe, expect, mock, test } from "bun:test";

process.env.TGBOT_API_KEY = "test-token-for-tests";
process.env.TGBOT_ALLOWED_USERS = "123";

const { createBot } = await import("./bot");
const { SessionStore } = await import("./session/store");

function buildCommandUpdate(text: string) {
  return {
    update_id: Date.now(),
    message: {
      message_id: 10,
      date: Math.floor(Date.now() / 1000),
      text,
      entities: [{ offset: 0, length: text.split(" ")[0]?.length ?? text.length, type: "bot_command" }],
      chat: { id: 456, type: "private" },
      from: { id: 123, is_bot: false, first_name: "Test" },
    },
  };
}

describe("/model", () => {
  test("aborts an active codex run, resets the thread, and preserves effort", async () => {
    const store = new SessionStore("/tmp/tg-agents-wrapper-bot-model-test.json");
    const session = store.get(123);
    session.engine = "codex";
    session.sessionId = "thread-123";
    session.codexModel = "gpt-5.4";
    session.reasoningEffort = "xhigh";
    session.isQueryActive = true;
    session.abortController = new AbortController();
    const abortSpy = mock(() => undefined);
    session.abortController.abort = abortSpy as typeof session.abortController.abort;
    store.set(123, session);

    const sendMessage = mock(async (_chatId: number, text: string) => ({
      message_id: 99,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 456, type: "private" },
      text,
    }));

    const codexInterrupt = mock(async () => false);
    const { bot } = createBot({
      token: "test-token",
      store,
      engines: {
        claude: {
          name: "claude",
          getSessionId: () => undefined,
          interrupt: async () => false,
          async *query() {},
        },
        codex: {
          name: "codex",
          getSessionId: () => undefined,
          interrupt: codexInterrupt,
          async *query() {},
        },
      },
      openaiClient: null,
      workingDir: process.cwd(),
      documentFilesDir: "/tmp",
      ttsConfig: {} as any,
    });

    bot.botInfo = {
      id: 1,
      is_bot: true,
      first_name: "TestBot",
      username: "testbot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
    } as any;
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === "sendMessage") {
        return {
          ok: true,
          result: await sendMessage(payload.chat_id as number, payload.text as string),
        };
      }

      if (method === "deleteMessage") {
        return { ok: true, result: true };
      }

      if (method === "editMessageText") {
        return { ok: true, result: { message_id: 99 } };
      }

      if (method === "sendChatAction") {
        return { ok: true, result: true };
      }

      throw new Error(`Unexpected API method in test: ${method}`);
    });

    await bot.handleUpdate(buildCommandUpdate("/model gpt-5.4-mini") as any);

    const updated = store.get(123);
    expect(codexInterrupt).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(updated.codexModel).toBe("gpt-5.4-mini");
    expect(updated.sessionId).toBeUndefined();
    expect(updated.reasoningEffort).toBe("xhigh");
    expect(sendMessage.mock.calls.at(-1)?.[1]).toBe(
      "Codex model switched to gpt-5.4-mini. A new Codex session will start on your next message."
    );
  });
});
