import type {
  GiftCatalogEntry,
  GiftCatalogEntryInput,
  GiftCatalogStore,
} from "../interfaces/gift-catalog-store.ts";

/**
 * In-memory `GiftCatalogStore`. Mirrors the Postgres impl's semantics:
 * upsert preserves `firstSeenAt`, advances `lastRefreshedAt`, and
 * overwrites every other field from the input. State is per-instance.
 */
export const createInMemoryGiftCatalogStore = (): GiftCatalogStore => {
  const entriesByGiftId = new Map<string, GiftCatalogEntry>();

  const upsert = (input: GiftCatalogEntryInput): GiftCatalogEntry => {
    const existing = entriesByGiftId.get(input.giftId);
    const firstSeenAt = existing?.firstSeenAt ?? input.observedAt;
    const lastRefreshedAt =
      existing === undefined || input.observedAt > existing.lastRefreshedAt
        ? input.observedAt
        : existing.lastRefreshedAt;

    const entry: GiftCatalogEntry = {
      giftId: input.giftId,
      publisherChatId: input.publisherChatId,
      publisherChatUsername: input.publisherChatUsername,
      publisherChatTitle: input.publisherChatTitle,
      publisherChatType: input.publisherChatType,
      starCount: input.starCount,
      upgradeStarCount: input.upgradeStarCount,
      totalCount: input.totalCount,
      remainingCount: input.remainingCount,
      stickerFileUniqueId: input.stickerFileUniqueId,
      raw: input.raw,
      firstSeenAt,
      lastRefreshedAt,
    };
    entriesByGiftId.set(input.giftId, entry);
    return entry;
  };

  return {
    upsertEntry(input) {
      return Promise.resolve(upsert(input));
    },

    upsertMany(inputs) {
      return Promise.resolve(inputs.map(upsert));
    },

    findByGiftId(giftId) {
      return Promise.resolve(entriesByGiftId.get(giftId) ?? null);
    },

    findByPublisherChatId(chatId) {
      const matches: GiftCatalogEntry[] = [];
      for (const entry of entriesByGiftId.values()) {
        if (entry.publisherChatId !== null && entry.publisherChatId === chatId) {
          matches.push(entry);
        }
      }
      return Promise.resolve(matches);
    },

    oldestRefreshedAt() {
      let oldest: Date | null = null;
      for (const entry of entriesByGiftId.values()) {
        if (oldest === null || entry.lastRefreshedAt < oldest) {
          oldest = entry.lastRefreshedAt;
        }
      }
      return Promise.resolve(oldest);
    },
  };
};
