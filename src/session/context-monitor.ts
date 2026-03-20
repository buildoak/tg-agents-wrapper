import type { Bot } from "grammy";

import type { ContextWarningEvent } from "../engine/interface";
import type { Session } from "../types";
import { SessionStore } from "./store";

/** Track which threshold level was last warned per user to avoid spamming. */
const lastWarnedLevel = new Map<number, number>();

/**
 * Check context fill thresholds using wet proxy values stored on the session.
 * Called after each query completes (from query.ts finally block).
 *
 * Thresholds:
 *   70% — info warning
 *   85% — strong warning
 *   90% — suggest /start reset
 */
export async function checkContextThresholds(
  session: Session,
  _store: SessionStore,
  chatId: number,
  bot: Bot,
): Promise<void> {
  const tokens = session.wetContextTokens;
  const window = session.wetContextWindow;

  // No wet data available — nothing to check
  if (!window || window <= 0 || !tokens) return;

  const pct = (tokens / window) * 100;
  const userId = chatId; // chatId is the user's chat in DM bot

  const previousLevel = lastWarnedLevel.get(userId) ?? 0;

  if (pct >= 90 && previousLevel < 90) {
    lastWarnedLevel.set(userId, 90);
    const tokensK = Math.round(tokens / 1000);
    const windowK = Math.round(window / 1000);
    await bot.api.sendMessage(
      chatId,
      `⚠️ Context ${pct.toFixed(0)}% full (${tokensK}k / ${windowK}k tokens). ` +
      `Session will autocompact soon. Send /start to reset cleanly.`,
    );
  } else if (pct >= 85 && previousLevel < 85) {
    lastWarnedLevel.set(userId, 85);
    const tokensK = Math.round(tokens / 1000);
    const windowK = Math.round(window / 1000);
    await bot.api.sendMessage(
      chatId,
      `⚠️ Context filling up: ${pct.toFixed(0)}% (${tokensK}k / ${windowK}k). ` +
      `Consider wrapping up or sending /start for a fresh session.`,
    );
  } else if (pct >= 70 && previousLevel < 70) {
    lastWarnedLevel.set(userId, 70);
    const tokensK = Math.round(tokens / 1000);
    const windowK = Math.round(window / 1000);
    await bot.api.sendMessage(
      chatId,
      `Context: ${pct.toFixed(0)}% (${tokensK}k / ${windowK}k tokens used).`,
    );
  }

  // Reset warning level if context drops (e.g., after /start)
  if (pct < 50 && previousLevel > 0) {
    lastWarnedLevel.set(userId, 0);
  }
}

export async function handleContextWarning(
  _event: ContextWarningEvent,
  _session: Session,
  _store: SessionStore,
  _chatId: number,
  _bot: Bot,
): Promise<void> {
  // SDK-level context warnings are now supplemented by wet-based threshold checking.
  // The checkContextThresholds function handles proactive warnings after each query.
}
