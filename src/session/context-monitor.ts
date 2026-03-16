import type { Bot } from "grammy";

import type { ContextWarningEvent } from "../engine/interface";
import type { Session } from "../types";
import { SessionStore } from "./store";

export async function handleContextWarning(
  event: ContextWarningEvent,
  session: Session,
  store: SessionStore,
  chatId: number,
  bot: Bot,
): Promise<void> {
  void event;
  void session;
  void store;
  void chatId;
  void bot;
  // Context warnings handled on-demand via /context command.
  // No automatic alerts or resets.
}
