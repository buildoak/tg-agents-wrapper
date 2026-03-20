import { describe, test, expect, mock, beforeEach } from "bun:test";
import { checkContextThresholds } from "./context-monitor";
import type { Session } from "../types";

// The module uses a module-level Map `lastWarnedLevel` that persists between calls.
// We need to reset it between tests. Since it's not exported, we can drive it
// below 50% to reset, or we use unique userId/chatId per test.

function makeSession(tokens: number, window: number): Session {
  return {
    engine: "claude",
    lastActivity: Date.now(),
    isQueryActive: false,
    wasInterruptedByNewMessage: false,
    isResetting: false,
    voiceMode: "off",
    voiceId: "",
    totalCostUSD: 0,
    lastInputTokens: 0,
    cumulativeInputTokens: 0,
    wetContextTokens: tokens,
    wetContextWindow: window,
    batchDelayMs: 0,
  };
}

function makeMockBot() {
  const sendMessage = mock(() => Promise.resolve());
  return {
    bot: { api: { sendMessage } } as any,
    sendMessage,
  };
}

// Use a fresh chatId for each test to avoid cross-test state in lastWarnedLevel
let chatIdCounter = 10000;

describe("checkContextThresholds", () => {
  beforeEach(() => {
    chatIdCounter += 100;
  });

  test("sends no warning below 70%", async () => {
    const chatId = chatIdCounter++;
    const session = makeSession(60000, 100000); // 60%
    const { bot, sendMessage } = makeMockBot();

    await checkContextThresholds(session, {} as any, chatId, bot);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sends info warning at 70%", async () => {
    const chatId = chatIdCounter++;
    const session = makeSession(70000, 100000); // 70%
    const { bot, sendMessage } = makeMockBot();

    await checkContextThresholds(session, {} as any, chatId, bot);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const msg = sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain("70%");
    expect(msg).toContain("70k / 100k");
  });

  test("sends strong warning at 85%", async () => {
    const chatId = chatIdCounter++;
    const session = makeSession(85000, 100000); // 85%
    const { bot, sendMessage } = makeMockBot();

    await checkContextThresholds(session, {} as any, chatId, bot);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const msg = sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain("85%");
    expect(msg).toContain("filling up");
  });

  test("sends reset suggestion at 90%", async () => {
    const chatId = chatIdCounter++;
    const session = makeSession(90000, 100000); // 90%
    const { bot, sendMessage } = makeMockBot();

    await checkContextThresholds(session, {} as any, chatId, bot);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const msg = sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain("90%");
    expect(msg).toContain("/start");
  });

  test("sends reset suggestion at 95%", async () => {
    const chatId = chatIdCounter++;
    const session = makeSession(95000, 100000); // 95%
    const { bot, sendMessage } = makeMockBot();

    await checkContextThresholds(session, {} as any, chatId, bot);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const msg = sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain("95%");
    expect(msg).toContain("/start");
  });

  test("does not re-fire at same level", async () => {
    const chatId = chatIdCounter++;
    const { bot, sendMessage } = makeMockBot();

    // First call at 70% — should warn
    const session70 = makeSession(70000, 100000);
    await checkContextThresholds(session70, {} as any, chatId, bot);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Second call still at 70% — should NOT warn again
    await checkContextThresholds(session70, {} as any, chatId, bot);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("escalates from 70 to 85 level", async () => {
    const chatId = chatIdCounter++;
    const { bot, sendMessage } = makeMockBot();

    // First at 70%
    const session70 = makeSession(70000, 100000);
    await checkContextThresholds(session70, {} as any, chatId, bot);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Then at 85%
    const session85 = makeSession(85000, 100000);
    await checkContextThresholds(session85, {} as any, chatId, bot);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("escalates from 85 to 90 level", async () => {
    const chatId = chatIdCounter++;
    const { bot, sendMessage } = makeMockBot();

    // First at 85%
    const session85 = makeSession(85000, 100000);
    await checkContextThresholds(session85, {} as any, chatId, bot);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Then at 90%
    const session90 = makeSession(90000, 100000);
    await checkContextThresholds(session90, {} as any, chatId, bot);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("resets warning level when context drops below 50%", async () => {
    const chatId = chatIdCounter++;
    const { bot, sendMessage } = makeMockBot();

    // Trigger 70% warning
    const session70 = makeSession(70000, 100000);
    await checkContextThresholds(session70, {} as any, chatId, bot);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Drop below 50%
    const session40 = makeSession(40000, 100000);
    await checkContextThresholds(session40, {} as any, chatId, bot);

    // Now at 70% again — should warn again
    await checkContextThresholds(session70, {} as any, chatId, bot);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("does not reset when above 50%", async () => {
    const chatId = chatIdCounter++;
    const { bot, sendMessage } = makeMockBot();

    // Trigger 70% warning
    const session70 = makeSession(70000, 100000);
    await checkContextThresholds(session70, {} as any, chatId, bot);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Drop to 55% — above reset threshold
    const session55 = makeSession(55000, 100000);
    await checkContextThresholds(session55, {} as any, chatId, bot);

    // Back to 70% — should NOT warn again because level wasn't reset
    await checkContextThresholds(session70, {} as any, chatId, bot);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("no-ops when wetContextWindow is 0", async () => {
    const chatId = chatIdCounter++;
    const session = makeSession(90000, 0);
    const { bot, sendMessage } = makeMockBot();

    await checkContextThresholds(session, {} as any, chatId, bot);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("no-ops when wetContextWindow is negative", async () => {
    const chatId = chatIdCounter++;
    const session = makeSession(90000, -1);
    const { bot, sendMessage } = makeMockBot();

    await checkContextThresholds(session, {} as any, chatId, bot);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("no-ops when wetContextTokens is 0", async () => {
    const chatId = chatIdCounter++;
    const session = makeSession(0, 100000);
    const { bot, sendMessage } = makeMockBot();

    await checkContextThresholds(session, {} as any, chatId, bot);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("handles large context windows correctly", async () => {
    const chatId = chatIdCounter++;
    // 1M context, 700k tokens = 70%
    const session = makeSession(700000, 1000000);
    const { bot, sendMessage } = makeMockBot();

    await checkContextThresholds(session, {} as any, chatId, bot);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const msg = sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain("700k / 1000k");
  });
});
