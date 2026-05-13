import { describe, expect, it, vi } from "vitest";
import type { TelegramIntelClient } from "../src/client.ts";
import { fetchAvailableGifts, fetchChatGifts } from "../src/gift-catalog.ts";

const client = (
  api: Partial<{
    getAvailableGifts: ReturnType<typeof vi.fn>;
    getChatGifts: ReturnType<typeof vi.fn>;
  }>,
  enabled = true,
): TelegramIntelClient => ({
  enabled,
  apiBaseUrl: "https://api.telegram.org",
  raw: api as unknown as TelegramIntelClient["raw"],
});

// Sample Gift / OwnedGift shapes per Bot API.
const sampleGift = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "5170145012310081615",
  sticker: { file_unique_id: "AgADfgADfgADfgAD" },
  star_count: 25,
  upgrade_star_count: 50,
  total_count: 100_000,
  remaining_count: 42_137,
  publisher_chat: {
    id: 1234567890,
    type: "channel",
    title: "Pavel Durov",
    username: "durov",
  },
  ...overrides,
});

const sampleUniqueOwnedGift = (overrides: Partial<Record<string, unknown>> = {}) => ({
  type: "unique" as const,
  send_date: 1_700_000_000,
  gift: {
    gift_id: "5170145012310081615",
    base_name: "PlushPepe",
    name: "PlushPepe-10",
    publisher_chat: { id: 1234567890, type: "channel", username: "durov" },
    is_from_blockchain: undefined,
    number: 10,
    model: { name: "Bavaria", sticker: {}, rarity_per_mille: 5 },
    symbol: { name: "Heart", sticker: {}, rarity_per_mille: 5 },
    backdrop: { name: "Turquoise", colors: {}, rarity_per_mille: 5 },
    ...overrides,
  },
});

describe("fetchAvailableGifts", () => {
  it("returns disabled when the client has no token", async () => {
    const result = await fetchAvailableGifts(client({}, false));
    expect(result.status).toBe("disabled");
  });

  it("normalises the catalog payload to GiftCatalogEntryInput shape", async () => {
    const getAvailableGifts = vi.fn().mockResolvedValue({ gifts: [sampleGift()] });
    const result = await fetchAvailableGifts(client({ getAvailableGifts }));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.gifts).toHaveLength(1);
    expect(result.gifts[0]).toMatchObject({
      giftId: "5170145012310081615",
      publisherChatId: 1234567890n,
      publisherChatUsername: "durov",
      publisherChatTitle: "Pavel Durov",
      publisherChatType: "channel",
      starCount: 25,
      upgradeStarCount: 50,
      totalCount: 100_000,
      remainingCount: 42_137,
      stickerFileUniqueId: "AgADfgADfgADfgAD",
    });
  });

  it("nulls out publisher_chat fields when Telegram omits the field", async () => {
    const getAvailableGifts = vi
      .fn()
      .mockResolvedValue({ gifts: [sampleGift({ publisher_chat: undefined })] });
    const result = await fetchAvailableGifts(client({ getAvailableGifts }));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.gifts[0]?.publisherChatId).toBeNull();
    expect(result.gifts[0]?.publisherChatUsername).toBeNull();
  });

  it("maps rate-limit errors to failed status", async () => {
    const getAvailableGifts = vi
      .fn()
      .mockRejectedValue({ error_code: 429, parameters: { retry_after: 30 } });
    const result = await fetchAvailableGifts(client({ getAvailableGifts }));

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.status).toBe("rate_limited");
  });
});

describe("fetchChatGifts", () => {
  it("returns disabled when the client has no token", async () => {
    const result = await fetchChatGifts(client({}, false), 1n);
    expect(result.status).toBe("disabled");
  });

  it("returns no_gifts when the chat exposes an empty list", async () => {
    const getChatGifts = vi.fn().mockResolvedValue({ gifts: [], next_offset: "" });
    const result = await fetchChatGifts(client({ getChatGifts }), 1234n);
    expect(result.status).toBe("not_resolvable");
    if (result.status !== "not_resolvable") return;
    expect(result.reason).toBe("no_gifts");
  });

  it("maps 'chat not found' to chat_not_accessible", async () => {
    const getChatGifts = vi
      .fn()
      .mockRejectedValue({ error_code: 400, description: "Bad Request: chat not found" });
    const result = await fetchChatGifts(client({ getChatGifts }), 999n);
    expect(result.status).toBe("not_resolvable");
    if (result.status !== "not_resolvable") return;
    expect(result.reason).toBe("chat_not_accessible");
  });

  it("pages through the inventory until next_offset is empty", async () => {
    const getChatGifts = vi
      .fn()
      .mockResolvedValueOnce({
        gifts: [sampleUniqueOwnedGift({ name: "A-1" })],
        next_offset: "cursor1",
      })
      .mockResolvedValueOnce({
        gifts: [sampleUniqueOwnedGift({ name: "A-2" })],
        next_offset: "",
      });

    const result = await fetchChatGifts(client({ getChatGifts }), 5n);

    expect(getChatGifts).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.gifts.map((g) => g.uniqueSlug)).toEqual(["A-1", "A-2"]);
    expect(result.truncated).toBe(false);
  });

  it("truncates when the per-scan cap is hit", async () => {
    const getChatGifts = vi.fn().mockResolvedValue({
      gifts: [
        sampleUniqueOwnedGift({ name: "A-1" }),
        sampleUniqueOwnedGift({ name: "A-2" }),
        sampleUniqueOwnedGift({ name: "A-3" }),
      ],
      next_offset: "cursor",
    });

    const result = await fetchChatGifts(client({ getChatGifts }), 5n, { cap: 2 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.gifts).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("returns partial results when a later page fails", async () => {
    const getChatGifts = vi
      .fn()
      .mockResolvedValueOnce({
        gifts: [sampleUniqueOwnedGift({ name: "A-1" })],
        next_offset: "cursor1",
      })
      .mockRejectedValueOnce({ error_code: 500 });

    const result = await fetchChatGifts(client({ getChatGifts }), 5n);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.gifts).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("normalises unique-gift fields including is_from_blockchain", async () => {
    const getChatGifts = vi.fn().mockResolvedValue({
      gifts: [
        sampleUniqueOwnedGift(),
        sampleUniqueOwnedGift({ name: "B-2", is_from_blockchain: true }),
      ],
      next_offset: "",
    });

    const result = await fetchChatGifts(client({ getChatGifts }), 5n);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.gifts[0]?.isFromBlockchain).toBe(false);
    expect(result.gifts[1]?.isFromBlockchain).toBe(true);
    expect(result.gifts[0]?.type).toBe("unique");
    expect(result.gifts[0]?.giftId).toBe("5170145012310081615");
  });
});
