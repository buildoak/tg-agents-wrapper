import { describe, expect, test } from "bun:test";

process.env.TGBOT_API_KEY = "test-token-for-tests";
process.env.TGBOT_ALLOWED_USERS = "123";

const { BOT_COMMANDS } = await import("./bot");

describe("Telegram command menu", () => {
  test("includes the Codex model switch command", () => {
    const modelCommand = BOT_COMMANDS.find((command) => command.command === "model");

    expect(modelCommand).toBeDefined();
    expect(modelCommand?.description).toContain("Codex");
  });
});
