import type { Bot } from "grammy";

import type { ContextWarningEvent } from "../engine/interface";
import type { Session } from "../types";
import { SessionStore } from "./store";

export async function handleContextWarning(
  _event: ContextWarningEvent,
  _session: Session,
  _store: SessionStore,
  _chatId: number,
  _bot: Bot,
): Promise<void> {
  // Context warnings handled on-demand via /context command.
  // No automatic alerts or resets.
}
