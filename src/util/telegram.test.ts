import { describe, test, expect, mock, beforeEach } from "bun:test";

// telegram.ts imports from ../config which calls validateConfig() at module level,
// requiring TGBOT_API_KEY. Set it before any import from telegram.ts.
process.env.TGBOT_API_KEY = "test-token-for-tests";

// Use dynamic import so the env var is set before the module loads
const { wrapMessage, getMimeType, sendLongMessageDirect } = await import("./telegram");
type WrapMessageMeta = import("./telegram").WrapMessageMeta;

describe("getMimeType", () => {
  test("returns image/jpeg for .jpg", () => {
    expect(getMimeType("photo.jpg")).toBe("image/jpeg");
  });

  test("returns image/jpeg for .jpeg", () => {
    expect(getMimeType("photo.jpeg")).toBe("image/jpeg");
  });

  test("returns image/png for .png", () => {
    expect(getMimeType("photo.png")).toBe("image/png");
  });

  test("returns image/gif for .gif", () => {
    expect(getMimeType("animation.gif")).toBe("image/gif");
  });

  test("returns image/webp for .webp", () => {
    expect(getMimeType("sticker.webp")).toBe("image/webp");
  });

  test("returns image/jpeg as default for unknown extension", () => {
    expect(getMimeType("file.bmp")).toBe("image/jpeg");
  });

  test("handles uppercase extensions", () => {
    expect(getMimeType("photo.JPG")).toBe("image/jpeg");
    expect(getMimeType("photo.PNG")).toBe("image/png");
  });

  test("handles filename with multiple dots", () => {
    expect(getMimeType("my.photo.file.png")).toBe("image/png");
  });

  test("handles filename with no extension", () => {
    expect(getMimeType("noext")).toBe("image/jpeg");
  });
});

describe("wrapMessage", () => {
  test("wraps with tg_message tag when voice is off", () => {
    const result = wrapMessage("hello", "off");
    expect(result).toBe("<tg_message>\nhello\n</tg_message>");
  });

  test("wraps with tg_message_voice tag when voice is cloud", () => {
    const result = wrapMessage("hello", "cloud");
    expect(result).toBe("<tg_message_voice>\nhello\n</tg_message_voice>");
  });

  test("wraps with tg_message_voice tag when voice is local", () => {
    const result = wrapMessage("hello", "local");
    expect(result).toBe("<tg_message_voice>\nhello\n</tg_message_voice>");
  });

  test("includes from attribute", () => {
    const meta: WrapMessageMeta = { username: "testuser" };
    const result = wrapMessage("hello", "off", meta);
    expect(result).toContain('from="testuser"');
  });

  test("includes ts attribute", () => {
    const meta: WrapMessageMeta = { timestamp: "2026-03-20T10:00:00Z" };
    const result = wrapMessage("hello", "off", meta);
    expect(result).toContain('ts="2026-03-20T10:00:00Z"');
  });

  test("includes media attribute", () => {
    const meta: WrapMessageMeta = { mediaType: "voice" };
    const result = wrapMessage("hello", "off", meta);
    expect(result).toContain('media="voice"');
  });

  test("includes forwarded attribute", () => {
    const meta: WrapMessageMeta = { isForwarded: true };
    const result = wrapMessage("hello", "off", meta);
    expect(result).toContain('forwarded="true"');
  });

  test("includes forward_from attribute", () => {
    const meta: WrapMessageMeta = { forwardOrigin: "channel_name" };
    const result = wrapMessage("hello", "off", meta);
    expect(result).toContain('forward_from="channel_name"');
  });

  test("includes reply_to child element", () => {
    const meta: WrapMessageMeta = { replyToText: "original message" };
    const result = wrapMessage("hello", "off", meta);
    expect(result).toContain("<reply_to>original message</reply_to>");
    expect(result).toContain("hello");
  });

  test("includes all attributes together", () => {
    const meta: WrapMessageMeta = {
      username: "user1",
      timestamp: "2026-03-20T10:00:00Z",
      mediaType: "photo",
      isForwarded: true,
      forwardOrigin: "source",
      replyToText: "quoted text",
    };
    const result = wrapMessage("body text", "off", meta);
    expect(result).toContain('from="user1"');
    expect(result).toContain('ts="2026-03-20T10:00:00Z"');
    expect(result).toContain('media="photo"');
    expect(result).toContain('forwarded="true"');
    expect(result).toContain('forward_from="source"');
    expect(result).toContain("<reply_to>quoted text</reply_to>");
    expect(result).toContain("body text");
  });

  test("escapes XML special characters in attribute values", () => {
    const meta: WrapMessageMeta = { username: 'user "with" <special> & chars' };
    const result = wrapMessage("hello", "off", meta);
    expect(result).toContain("&quot;");
    expect(result).toContain("&lt;");
    expect(result).toContain("&gt;");
    expect(result).toContain("&amp;");
  });

  test("escapes XML special characters in reply_to content", () => {
    const meta: WrapMessageMeta = { replyToText: "text with <html> & stuff" };
    const result = wrapMessage("hello", "off", meta);
    expect(result).toContain("&lt;html&gt;");
    expect(result).toContain("&amp;");
  });

  test("does not include false-y forwarded attribute", () => {
    const meta: WrapMessageMeta = { isForwarded: false };
    const result = wrapMessage("hello", "off", meta);
    expect(result).not.toContain("forwarded");
  });

  test("handles no meta at all", () => {
    const result = wrapMessage("hello", "off");
    expect(result).toBe("<tg_message>\nhello\n</tg_message>");
  });

  test("handles empty meta object", () => {
    const result = wrapMessage("hello", "off", {});
    expect(result).toBe("<tg_message>\nhello\n</tg_message>");
  });
});

describe("sendLongMessageDirect", () => {
  function makeMockBot() {
    const sendMessage = mock(() => Promise.resolve());
    return {
      bot: { api: { sendMessage } } as any,
      sendMessage,
    };
  }

  test("sends short message in one call", async () => {
    const { bot, sendMessage } = makeMockBot();
    await sendLongMessageDirect(bot, 123, "short message", 4000);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toBe("short message");
  });

  test("splits long message at newline boundary", async () => {
    const { bot, sendMessage } = makeMockBot();
    const part1 = "a".repeat(30);
    const part2 = "b".repeat(30);
    const message = part1 + "\n" + part2;
    await sendLongMessageDirect(bot, 123, message, 40);
    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("splits at space when no newline in reasonable range", async () => {
    const { bot, sendMessage } = makeMockBot();
    const message = Array(20).fill("word").join(" ");
    await sendLongMessageDirect(bot, 123, message, 30);
    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("hard splits when no good break point", async () => {
    const { bot, sendMessage } = makeMockBot();
    const message = "x".repeat(100);
    await sendLongMessageDirect(bot, 123, message, 40);
    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  test("passes parse_mode when provided", async () => {
    const { bot, sendMessage } = makeMockBot();
    await sendLongMessageDirect(bot, 123, "hello", 4000, "HTML");
    expect(sendMessage.mock.calls[0][2]).toEqual({ parse_mode: "HTML" });
  });
});
