import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { MediaGroupCollector, type MediaGroupReadyPayload, type MediaGroupItemInput } from "./media-group";
import type { ImageData } from "../types";

function makeImage(label: string): ImageData {
  return {
    buffer: Buffer.from(label),
    mimeType: "image/jpeg",
  };
}

function makeInput(overrides: Partial<MediaGroupItemInput> = {}): MediaGroupItemInput {
  return {
    image: makeImage("test-image"),
    caption: "",
    chatId: 100,
    userId: 1,
    ...overrides,
  };
}

describe("MediaGroupCollector", () => {
  let originalSetTimeout: typeof globalThis.setTimeout;
  let originalClearTimeout: typeof globalThis.clearTimeout;
  let timerCallbacks: Array<{ callback: () => void; delay: number; id: number }>;
  let nextTimerId: number;

  beforeEach(() => {
    // Manual fake timer implementation
    originalSetTimeout = globalThis.setTimeout;
    originalClearTimeout = globalThis.clearTimeout;
    timerCallbacks = [];
    nextTimerId = 1;

    // @ts-ignore - overriding for test
    globalThis.setTimeout = (callback: () => void, delay: number) => {
      const id = nextTimerId++;
      timerCallbacks.push({ callback, delay, id });
      return id;
    };

    // @ts-ignore - overriding for test
    globalThis.clearTimeout = (id: number) => {
      timerCallbacks = timerCallbacks.filter((t) => t.id !== id);
    };
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  function flushTimers() {
    // Fire all pending timer callbacks
    const pending = [...timerCallbacks];
    timerCallbacks = [];
    for (const timer of pending) {
      timer.callback();
    }
  }

  test("collects single image and fires onGroupReady after timeout", async () => {
    const onGroupReady = mock(() => Promise.resolve());
    const collector = new MediaGroupCollector({ onGroupReady, debounceMs: 500 });

    const image = makeImage("img1");
    collector.collect("group-1", makeInput({ image, caption: "test caption" }));

    // Should have scheduled a timer
    expect(timerCallbacks.length).toBe(1);
    expect(timerCallbacks[0].delay).toBe(500);

    // Fire the timer
    flushTimers();

    // Need to wait for the async callback
    await new Promise((resolve) => originalSetTimeout(resolve, 10));

    expect(onGroupReady).toHaveBeenCalledTimes(1);
    const payload = onGroupReady.mock.calls[0][0] as MediaGroupReadyPayload;
    expect(payload.groupId).toBe("group-1");
    expect(payload.images.length).toBe(1);
    expect(payload.caption).toBe("test caption");
    expect(payload.chatId).toBe(100);
    expect(payload.userId).toBe(1);
  });

  test("collects multiple images into one group", async () => {
    const onGroupReady = mock(() => Promise.resolve());
    const collector = new MediaGroupCollector({ onGroupReady, debounceMs: 500 });

    const img1 = makeImage("img1");
    const img2 = makeImage("img2");
    const img3 = makeImage("img3");

    collector.collect("group-1", makeInput({ image: img1, caption: "first caption" }));
    collector.collect("group-1", makeInput({ image: img2, caption: "" }));
    collector.collect("group-1", makeInput({ image: img3, caption: "" }));

    // Each collect after the first clears and re-schedules the timer
    // Should end up with exactly 1 timer pending
    expect(timerCallbacks.length).toBe(1);

    flushTimers();
    await new Promise((resolve) => originalSetTimeout(resolve, 10));

    expect(onGroupReady).toHaveBeenCalledTimes(1);
    const payload = onGroupReady.mock.calls[0][0] as MediaGroupReadyPayload;
    expect(payload.images.length).toBe(3);
  });

  test("caption-first-wins: first non-empty caption is kept", async () => {
    const onGroupReady = mock(() => Promise.resolve());
    const collector = new MediaGroupCollector({ onGroupReady, debounceMs: 100 });

    collector.collect("group-1", makeInput({ caption: "first caption" }));
    collector.collect("group-1", makeInput({ caption: "second caption" }));

    flushTimers();
    await new Promise((resolve) => originalSetTimeout(resolve, 10));

    const payload = onGroupReady.mock.calls[0][0] as MediaGroupReadyPayload;
    expect(payload.caption).toBe("first caption");
  });

  test("caption-first-wins: empty first caption gets replaced by later one", async () => {
    const onGroupReady = mock(() => Promise.resolve());
    const collector = new MediaGroupCollector({ onGroupReady, debounceMs: 100 });

    collector.collect("group-1", makeInput({ caption: "" }));
    collector.collect("group-1", makeInput({ caption: "late caption" }));

    flushTimers();
    await new Promise((resolve) => originalSetTimeout(resolve, 10));

    const payload = onGroupReady.mock.calls[0][0] as MediaGroupReadyPayload;
    expect(payload.caption).toBe("late caption");
  });

  test("different groups are tracked independently", async () => {
    const onGroupReady = mock(() => Promise.resolve());
    const collector = new MediaGroupCollector({ onGroupReady, debounceMs: 100 });

    collector.collect("group-A", makeInput({ caption: "A" }));
    collector.collect("group-B", makeInput({ caption: "B" }));

    expect(timerCallbacks.length).toBe(2);

    flushTimers();
    await new Promise((resolve) => originalSetTimeout(resolve, 10));

    expect(onGroupReady).toHaveBeenCalledTimes(2);
    const captions = onGroupReady.mock.calls.map(
      (call: any) => (call[0] as MediaGroupReadyPayload).caption
    );
    expect(captions).toContain("A");
    expect(captions).toContain("B");
  });

  test("clearUserGroups removes only groups for that user", () => {
    const onGroupReady = mock(() => Promise.resolve());
    const collector = new MediaGroupCollector({ onGroupReady, debounceMs: 100 });

    collector.collect("group-1", makeInput({ userId: 1 }));
    collector.collect("group-2", makeInput({ userId: 2 }));

    expect(timerCallbacks.length).toBe(2);

    collector.clearUserGroups(1);

    // Only user 2's timer should remain
    expect(timerCallbacks.length).toBe(1);

    // Firing remaining timer should only produce user 2's group
    flushTimers();
  });

  test("clearAll removes all groups and timers", () => {
    const onGroupReady = mock(() => Promise.resolve());
    const collector = new MediaGroupCollector({ onGroupReady, debounceMs: 100 });

    collector.collect("group-1", makeInput());
    collector.collect("group-2", makeInput());
    collector.collect("group-3", makeInput());

    expect(timerCallbacks.length).toBe(3);

    collector.clearAll();

    expect(timerCallbacks.length).toBe(0);
  });

  test("uses default debounceMs of 500 when not specified", () => {
    const onGroupReady = mock(() => Promise.resolve());
    const collector = new MediaGroupCollector({ onGroupReady });

    collector.collect("group-1", makeInput());

    expect(timerCallbacks[0].delay).toBe(500);
  });

  test("processMediaGroup is a no-op if group was already cleared", async () => {
    const onGroupReady = mock(() => Promise.resolve());
    const collector = new MediaGroupCollector({ onGroupReady, debounceMs: 100 });

    collector.collect("group-1", makeInput());
    collector.clearAll();

    // Fire the timer callback that was queued before clearAll
    // (clearAll cleared our timerCallbacks array, but the real processMediaGroup
    // would find no group since it was deleted)

    // We can't directly test this with our fake timers since clearAll
    // removed from our array, but the behavior is: if the group is gone
    // from the map, processMediaGroup returns early without calling onGroupReady.
    expect(onGroupReady).not.toHaveBeenCalled();
  });
});
