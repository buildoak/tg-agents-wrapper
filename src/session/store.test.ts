import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.TGBOT_API_KEY = "test-token-for-tests";
delete process.env.TG_FORCE_DEFAULTS_ON_START;

const { SessionStore } = await import("./store");

describe("SessionStore codex model persistence", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("persists a custom codex model even without a session id", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tg-agents-wrapper-store-"));
    const sessionFile = join(tempDir, "sessions.json");

    const store = new SessionStore(sessionFile);
    const session = store.get(123);
    session.codexModel = "gpt-5.4-mini";
    store.set(123, session);

    await store.save();

    const restoredStore = new SessionStore(sessionFile);
    await restoredStore.load();

    expect(restoredStore.get(123).codexModel).toBe("gpt-5.4-mini");
    expect(restoredStore.get(123).sessionId).toBeUndefined();
  });

  test("persists a goal even without a session id", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tg-agents-wrapper-store-"));
    const sessionFile = join(tempDir, "sessions.json");

    const store = new SessionStore(sessionFile);
    const session = store.get(123);
    session.goal = "Keep the bot focused on the incident.";
    store.set(123, session);

    await store.save();

    const restoredStore = new SessionStore(sessionFile);
    await restoredStore.load();

    expect(restoredStore.get(123).goal).toBe("Keep the bot focused on the incident.");
    expect(restoredStore.get(123).sessionId).toBeUndefined();
  });
});
