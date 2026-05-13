import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryGiftCatalogStore, type GiftCatalogStore } from "@tonshield/storage";
import type { TelegramIntelClient } from "@tonshield/telegram-intel";
import { scanChatGiftsForUnknownPublisher } from "../src/telegram/gift-publisher-scanner.ts";

const buildClient = (
  getChatGifts: ReturnType<typeof vi.fn>,
  enabled = true,
): TelegramIntelClient => ({
  enabled,
  apiBaseUrl: "https://api.telegram.org",
  raw: { getChatGifts } as unknown as TelegramIntelClient["raw"],
});

const uniqueGift = (
  giftId: string,
  slug: string,
  publisherId: number | null,
  isFromBlockchain = false,
) => ({
  type: "unique" as const,
  send_date: 1,
  gift: {
    gift_id: giftId,
    base_name: slug.split("-")[0],
    name: slug,
    number: Number.parseInt(slug.split("-")[1] ?? "1", 10),
    model: { name: "m", sticker: {}, rarity_per_mille: 1 },
    symbol: { name: "s", sticker: {}, rarity_per_mille: 1 },
    backdrop: { name: "b", colors: {}, rarity_per_mille: 1 },
    publisher_chat:
      publisherId === null ? undefined : { id: publisherId, type: "channel", username: "pub" },
    is_from_blockchain: isFromBlockchain ? true : undefined,
  },
});

const seedCatalog = async (
  store: GiftCatalogStore,
  giftId: string,
  publisherId: number | null,
): Promise<void> => {
  await store.upsertEntry({
    giftId,
    publisherChatId: publisherId === null ? null : BigInt(publisherId),
    publisherChatUsername: "pub",
    publisherChatTitle: "Pub",
    publisherChatType: "channel",
    starCount: 25,
    upgradeStarCount: null,
    totalCount: null,
    remainingCount: null,
    stickerFileUniqueId: null,
    observedAt: new Date("2026-05-13T00:00:00Z"),
    raw: null,
  });
};

describe("scanChatGiftsForUnknownPublisher", () => {
  let store: GiftCatalogStore;

  beforeEach(() => {
    store = createInMemoryGiftCatalogStore();
  });

  it("returns no findings when the bot cannot access the chat", async () => {
    await seedCatalog(store, "baseline", 1);
    const getChatGifts = vi
      .fn()
      .mockRejectedValue({ error_code: 400, description: "Bad Request: chat not found" });
    const client = buildClient(getChatGifts);

    const result = await scanChatGiftsForUnknownPublisher(client, store, 1n);
    expect(result.findings).toEqual([]);
  });

  it("returns no findings when the chat has no owned gifts", async () => {
    await seedCatalog(store, "baseline", 1);
    const getChatGifts = vi.fn().mockResolvedValue({ gifts: [], next_offset: "" });
    const client = buildClient(getChatGifts);

    const result = await scanChatGiftsForUnknownPublisher(client, store, 1n);
    expect(result.findings).toEqual([]);
  });

  it("returns no findings before the catalog has ever been refreshed", async () => {
    const getChatGifts = vi.fn().mockResolvedValue({
      gifts: [uniqueGift("missing-gift", "Mystery-1", 1)],
      next_offset: "",
    });
    const client = buildClient(getChatGifts);

    const result = await scanChatGiftsForUnknownPublisher(client, store, 42n);
    expect(result.findings).toEqual([]);
    expect(getChatGifts).not.toHaveBeenCalled();
  });

  it("emits TELEGRAM_GIFT_FROM_UNKNOWN_PUBLISHER when a gift_id is absent from the catalog", async () => {
    await seedCatalog(store, "known-gift", 1);
    const getChatGifts = vi.fn().mockResolvedValue({
      gifts: [uniqueGift("missing-gift", "Mystery-1", 1)],
      next_offset: "",
    });
    const client = buildClient(getChatGifts);

    const result = await scanChatGiftsForUnknownPublisher(client, store, 42n);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe("TELEGRAM_GIFT_FROM_UNKNOWN_PUBLISHER");
    expect(result.findings[0]?.confidence).toBe("medium");
    expect(result.findings[0]?.evidence).toMatchObject({
      chatId: "42",
      inspectedCount: 1,
      flaggedCount: 1,
    });
    expect(result.findings[0]?.evidence.gifts).toEqual([
      {
        giftId: "missing-gift",
        slug: "Mystery-1",
        reason: "catalog_miss",
        ownedPublisherChatId: "1",
      },
    ]);
  });

  it("does NOT flag a catalog-miss when the gift is from the TON blockchain", async () => {
    await seedCatalog(store, "known-gift", 1);
    const getChatGifts = vi.fn().mockResolvedValue({
      gifts: [uniqueGift("ton-gift", "Token-1", 1, true)],
      next_offset: "",
    });
    const client = buildClient(getChatGifts);

    const result = await scanChatGiftsForUnknownPublisher(client, store, 1n);
    expect(result.findings).toEqual([]);
  });

  it("emits high confidence on a publisher_chat_id mismatch", async () => {
    await seedCatalog(store, "g-1", 100);
    const getChatGifts = vi.fn().mockResolvedValue({
      gifts: [uniqueGift("g-1", "Slug-1", 999)],
      next_offset: "",
    });
    const client = buildClient(getChatGifts);

    const result = await scanChatGiftsForUnknownPublisher(client, store, 1n);
    expect(result.findings[0]?.confidence).toBe("high");
    expect(result.findings[0]?.evidence.gifts).toEqual([
      {
        giftId: "g-1",
        slug: "Slug-1",
        reason: "publisher_mismatch",
        ownedPublisherChatId: "999",
        catalogPublisherChatId: "100",
      },
    ]);
  });

  it("passes when the catalog entry's publisher matches the owned gift's publisher", async () => {
    await seedCatalog(store, "g-2", 5);
    const getChatGifts = vi.fn().mockResolvedValue({
      gifts: [uniqueGift("g-2", "Match-1", 5)],
      next_offset: "",
    });
    const client = buildClient(getChatGifts);

    const result = await scanChatGiftsForUnknownPublisher(client, store, 1n);
    expect(result.findings).toEqual([]);
  });

  it("skips regular (non-unique) owned gifts entirely", async () => {
    await seedCatalog(store, "baseline", 1);
    const getChatGifts = vi.fn().mockResolvedValue({
      gifts: [
        {
          type: "regular",
          send_date: 1,
          gift: { id: "regular-id", sticker: {}, star_count: 25 },
        },
      ],
      next_offset: "",
    });
    const client = buildClient(getChatGifts);

    const result = await scanChatGiftsForUnknownPublisher(client, store, 1n);
    expect(result.findings).toEqual([]);
  });
});
