import type { Bot } from "grammy";

import type { EngineAdapter } from "../engine/interface";
import type { EngineType, Session } from "../types";
import { SessionStore } from "./store";

type ResetEngine = EngineType | EngineAdapter;

function resetSessionContext(session: Session): void {
  session.sessionId = undefined;
  session.lastInputTokens = 0;
  session.cumulativeInputTokens = 0;
  session.lastModelUsage = undefined;
  session.totalCostUSD = 0;
}

export async function abortUserQuery(
  userId: number,
  adapter: EngineAdapter,
  store: SessionStore,
  isInterrupt = false,
): Promise<void> {
  const session = store.getAll().get(userId);
  if (!session) {
    return;
  }

  if (isInterrupt) {
    session.wasInterruptedByNewMessage = true;
  }

  if (!session.isQueryActive && !session.abortController) {
    return;
  }

  let interrupted = false;
  try {
    interrupted = await adapter.interrupt();
  } catch (error) {
    console.warn(`[interrupt] adapter interrupt failed for user ${userId}:`, error);
  }

  if (!interrupted && session.abortController) {
    session.abortController.abort();
  }

  session.abortController = undefined;
  session.isQueryActive = false;
  store.set(userId, session);
}

export function consumeInterruptFlag(session: Session): boolean {
  const wasInterrupted = session.wasInterruptedByNewMessage;
  session.wasInterruptedByNewMessage = false;
  return wasInterrupted;
}

export async function resetSession(
  userId: number,
  engine: ResetEngine,
  store: SessionStore,
  chatId: number,
  bot: Bot,
): Promise<void> {
  const session = store.getAll().get(userId);
  if (!session) {
    await bot.api.sendMessage(chatId, "No active session to reset.");
    return;
  }

  if (session.isResetting) {
    await bot.api.sendMessage(chatId, "Reset already in progress...");
    return;
  }

  session.isResetting = true;
  store.set(userId, session);

  try {
    if (typeof engine !== "string") {
      await abortUserQuery(userId, engine, store);
    } else if (session.abortController) {
      session.abortController.abort();
      session.abortController = undefined;
      session.isQueryActive = false;
    }

    resetSessionContext(session);
    await store.save();
    await bot.api.sendMessage(chatId, "Session reset. New session will start on your next message.");
  } catch (error) {
    console.error("[reset] session reset failed:", error);
    await bot.api.sendMessage(
      chatId,
      `Reset failed: ${String(error).slice(0, 200)}`,
    );
  } finally {
    session.isResetting = false;
    store.set(userId, session);
  }
}
