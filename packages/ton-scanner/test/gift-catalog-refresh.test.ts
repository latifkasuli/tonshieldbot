import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryGiftCatalogStore } from "@tonshield/storage";
import type { TelegramIntelClient } from "@tonshield/telegram-intel";
import { refreshGiftCatalog } from "../src/telegram/gift-catalog-refresh.ts";

const buildClient = (
  getAvailableGifts: ReturnType<typeof vi.fn>,
  enabled = true,
): TelegramIntelClient => ({
  enabled,
  apiBaseUrl: "https://api.telegram.org",
  raw: { getAvailableGifts } as unknown as TelegramIntelClient["raw"],
});

const sampleGift = (id: string, publisherId: number | null = 1) => ({
  id,
  sticker: { file_unique_id: `sticker-${id}` },
  star_count: 25,
  publisher_chat:
    publisherId === null
      ? undefined
      : { id: publisherId, type: "channel", username: "pub", title: "Pub" },
});

describe("refreshGiftCatalog", () => {
  let store = createInMemoryGiftCatalogStore();

  beforeEach(() => {
    store = createInMemoryGiftCatalogStore();
  });

  it("returns disabled when the client has no token", async () => {
    const client = buildClient(vi.fn(), false);
    const result = await refreshGiftCatalog(client, store, new Date());
    expect(result.status).toBe("disabled");
  });

  it("upserts every catalog entry returned by the Bot API", async () => {
    const getAvailableGifts = vi
      .fn()
      .mockResolvedValue({ gifts: [sampleGift("g1"), sampleGift("g2", 2)] });
    const client = buildClient(getAvailableGifts);

    const result = await refreshGiftCatalog(client, store, new Date("2026-05-13T00:00:00Z"));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.refreshedCount).toBe(2);
    expect((await store.findByGiftId("g1"))?.publisherChatId).toBe(1n);
    expect((await store.findByGiftId("g2"))?.publisherChatId).toBe(2n);
  });

  it("propagates a Bot API rate-limit failure", async () => {
    const getAvailableGifts = vi
      .fn()
      .mockRejectedValue({ error_code: 429, parameters: { retry_after: 10 } });
    const client = buildClient(getAvailableGifts);

    const result = await refreshGiftCatalog(client, store, new Date());
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.status).toBe("rate_limited");
  });

  it("treats an empty catalog as ok with refreshedCount=0", async () => {
    const getAvailableGifts = vi.fn().mockResolvedValue({ gifts: [] });
    const client = buildClient(getAvailableGifts);

    const result = await refreshGiftCatalog(client, store, new Date());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.refreshedCount).toBe(0);
  });
});
