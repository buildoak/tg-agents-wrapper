import { existsSync } from "fs";

import { config, DEFAULT_ENGINE, DEFAULT_REASONING_EFFORT } from "../config";
import { normalizeVoiceMode, type EngineType, type PersistedSession, type Session } from "../types";

type PersistedSessionRecord = Record<string, PersistedSession | (Omit<PersistedSession, "engine"> & { engine?: EngineType })>;

const DEFAULT_BATCH_DELAY_MS = 15_000;

export class SessionStore {
  private readonly sessions = new Map<number, Session>();
  private readonly sessionFilePath: string;

  constructor(sessionFilePath: string = config.sessionFilePath) {
    this.sessionFilePath = sessionFilePath;
  }

  get(userId: number): Session {
    let session = this.sessions.get(userId);
    if (!session) {
      session = this.createDefaultSession();
      this.sessions.set(userId, session);
    }
    return session;
  }

  set(userId: number, session: Session): void {
    this.sessions.set(userId, session);
  }

  delete(userId: number): boolean {
    return this.sessions.delete(userId);
  }

  has(userId: number): boolean {
    return this.sessions.has(userId);
  }

  getAll(): Map<number, Session> {
    return this.sessions;
  }

  async save(): Promise<void> {
    try {
      const data: Record<string, PersistedSession> = {};

      for (const [userId, session] of this.sessions.entries()) {
        if (!session.sessionId) {
          continue;
        }

        data[userId] = {
          sessionId: session.sessionId,
          engine: session.engine,
          lastActivity: session.lastActivity,
          voiceMode: session.voiceMode,
          voiceId: session.voiceId,
          reasoningEffort: session.reasoningEffort,
          showThinking: session.showThinking,
          lastModelUsage: session.lastModelUsage,
          totalCostUSD: session.totalCostUSD,
          lastInputTokens: session.lastInputTokens,
          cumulativeInputTokens: session.cumulativeInputTokens,
          batchDelayMs: session.batchDelayMs,
        };
      }

      await Bun.write(this.sessionFilePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error("Failed to save sessions:", error);
    }
  }

  async load(): Promise<void> {
    try {
      if (!existsSync(this.sessionFilePath)) {
        return;
      }

      const raw = await Bun.file(this.sessionFilePath).text();
      const data = JSON.parse(raw) as PersistedSessionRecord;
      this.sessions.clear();

      for (const [userIdStr, persisted] of Object.entries(data)) {
        const userId = Number.parseInt(userIdStr, 10);
        if (Number.isNaN(userId) || !persisted.sessionId) {
          continue;
        }

        const restored: Session = {
          sessionId: persisted.sessionId,
          engine: persisted.engine ?? DEFAULT_ENGINE,
          lastActivity: persisted.lastActivity || Date.now(),
          wasInterruptedByNewMessage: false,
          voiceMode: normalizeVoiceMode(persisted.voiceMode),
          voiceId: persisted.voiceId || config.defaultVoiceId,
          reasoningEffort: persisted.reasoningEffort,
          showThinking: persisted.showThinking ?? false,
          lastModelUsage: persisted.lastModelUsage,
          totalCostUSD: persisted.totalCostUSD || 0,
          lastInputTokens: persisted.lastInputTokens || 0,
          cumulativeInputTokens:
            persisted.cumulativeInputTokens ?? persisted.lastInputTokens ?? 0,
          batchDelayMs: persisted.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS,
          isResetting: false,
          isQueryActive: false,
        };

        this.sessions.set(userId, restored);
        console.log(`Restored session for user ${userId}: ${persisted.sessionId.slice(0, 8)}...`);
      }
    } catch (error) {
      console.error("Failed to load sessions:", error);
    }
  }

  private createDefaultSession(): Session {
    return {
      engine: DEFAULT_ENGINE,
      lastActivity: Date.now(),
      wasInterruptedByNewMessage: false,
      voiceMode: "off",
      voiceId: config.defaultVoiceId,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      showThinking: false,
      totalCostUSD: 0,
      lastInputTokens: 0,
      cumulativeInputTokens: 0,
      batchDelayMs: DEFAULT_BATCH_DELAY_MS,
      isResetting: false,
      isQueryActive: false,
    };
  }
}
