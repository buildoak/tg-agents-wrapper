import { type ImageData } from "../types";

interface MediaGroupState {
  images: ImageData[];
  caption: string;
  chatId: number;
  userId: number;
  timeout: ReturnType<typeof setTimeout>;
}

export interface MediaGroupReadyPayload {
  groupId: string;
  images: ImageData[];
  caption: string;
  chatId: number;
  userId: number;
}

export interface MediaGroupCollectorDeps {
  onGroupReady: (payload: MediaGroupReadyPayload) => Promise<void>;
  debounceMs?: number;
}

export interface MediaGroupItemInput {
  image: ImageData;
  caption: string;
  chatId: number;
  userId: number;
}

export class MediaGroupCollector {
  private readonly groups = new Map<string, MediaGroupState>();
  private readonly debounceMs: number;

  constructor(private readonly deps: MediaGroupCollectorDeps) {
    this.debounceMs = deps.debounceMs ?? 500;
  }

  private scheduleProcessing(groupId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.processMediaGroup(groupId).catch((error) => {
        console.error(`Failed to process media group ${groupId}:`, error);
      });
    }, this.debounceMs);
  }

  collect(groupId: string, input: MediaGroupItemInput): void {
    const existing = this.groups.get(groupId);

    if (!existing) {
      const state: MediaGroupState = {
        images: [input.image],
        caption: input.caption,
        chatId: input.chatId,
        userId: input.userId,
        timeout: this.scheduleProcessing(groupId),
      };

      this.groups.set(groupId, state);
      return;
    }

    clearTimeout(existing.timeout);
    existing.timeout = this.scheduleProcessing(groupId);

    existing.images.push(input.image);
    if (input.caption && !existing.caption) {
      existing.caption = input.caption;
    }
  }

  clearUserGroups(userId: number): void {
    for (const [groupId, group] of this.groups.entries()) {
      if (group.userId !== userId) {
        continue;
      }

      clearTimeout(group.timeout);
      this.groups.delete(groupId);
    }
  }

  clearAll(): void {
    for (const group of this.groups.values()) {
      clearTimeout(group.timeout);
    }

    this.groups.clear();
  }

  private async processMediaGroup(groupId: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) {
      return;
    }

    this.groups.delete(groupId);

    await this.deps.onGroupReady({
      groupId,
      images: group.images,
      caption: group.caption,
      chatId: group.chatId,
      userId: group.userId,
    });
  }
}
