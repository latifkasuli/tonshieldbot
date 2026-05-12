import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryGiftCatalogStore } from "../src/memory/gift-catalog-store.ts";
import type {
  GiftCatalogEntryInput,
  GiftCatalogStore,
} from "../src/interfaces/gift-catalog-store.ts";

const baseInput = (overrides: Partial<GiftCatalogEntryInput> = {}): GiftCatalogEntryInput => ({
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
  observedAt: new Date("2026-05-12T00:00:00Z"),
  raw: null,
  ...overrides,
});

describe("in-memory GiftCatalogStore — upsertEntry", () => {
  let store: GiftCatalogStore;

  beforeEach(() => {
    store = createInMemoryGiftCatalogStore();
  });

  it("inserts a first-time entry and sets firstSeenAt = lastRefreshedAt = observedAt", async () => {
    const entry = await store.upsertEntry(baseInput());

    expect(entry.giftId).toBe("5170145012310081615");
    expect(entry.firstSeenAt.toISOString()).toBe("2026-05-12T00:00:00.000Z");
    expect(entry.lastRefreshedAt.toISOString()).toBe("2026-05-12T00:00:00.000Z");
    expect(entry.publisherChatId).toBe(1234567890n);
    expect(entry.starCount).toBe(25);
  });

  it("preserves firstSeenAt on subsequent upserts and advances lastRefreshedAt", async () => {
    await store.upsertEntry(baseInput());

    const entry = await store.upsertEntry(
      baseInput({
        observedAt: new Date("2026-05-13T00:00:00Z"),
        remainingCount: 41_000,
      }),
    );

    expect(entry.firstSeenAt.toISOString()).toBe("2026-05-12T00:00:00.000Z");
    expect(entry.lastRefreshedAt.toISOString()).toBe("2026-05-13T00:00:00.000Z");
    expect(entry.remainingCount).toBe(41_000);
  });

  it("does NOT regress lastRefreshedAt when an older observation is upserted", async () => {
    await store.upsertEntry(baseInput({ observedAt: new Date("2026-05-13T00:00:00Z") }));

    const entry = await store.upsertEntry(
      baseInput({ observedAt: new Date("2026-05-10T00:00:00Z") }),
    );

    expect(entry.lastRefreshedAt.toISOString()).toBe("2026-05-13T00:00:00.000Z");
  });

  it("overwrites publisher_chat fields on upsert (catalog re-issue)", async () => {
    await store.upsertEntry(baseInput());

    const entry = await store.upsertEntry(
      baseInput({
        observedAt: new Date("2026-06-01T00:00:00Z"),
        publisherChatId: 99n,
        publisherChatUsername: "newpublisher",
        publisherChatTitle: "New Publisher",
      }),
    );

    expect(entry.publisherChatId).toBe(99n);
    expect(entry.publisherChatUsername).toBe("newpublisher");
  });
});

describe("in-memory GiftCatalogStore — upsertMany", () => {
  it("upserts a batch and returns one entry per input", async () => {
    const store = createInMemoryGiftCatalogStore();
    const results = await store.upsertMany([
      baseInput({ giftId: "1" }),
      baseInput({ giftId: "2", publisherChatId: 2n }),
      baseInput({ giftId: "3", publisherChatId: 3n }),
    ]);

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.giftId)).toEqual(["1", "2", "3"]);
  });

  it("returns an empty array for an empty input", async () => {
    const store = createInMemoryGiftCatalogStore();
    expect(await store.upsertMany([])).toEqual([]);
  });
});

describe("in-memory GiftCatalogStore — lookups", () => {
  let store: GiftCatalogStore;

  beforeEach(async () => {
    store = createInMemoryGiftCatalogStore();
    await store.upsertMany([
      baseInput({ giftId: "g1", publisherChatId: 1n }),
      baseInput({ giftId: "g2", publisherChatId: 1n }),
      baseInput({ giftId: "g3", publisherChatId: 2n }),
      baseInput({ giftId: "g4", publisherChatId: null }),
    ]);
  });

  it("findByGiftId returns the entry for a known id", async () => {
    const entry = await store.findByGiftId("g2");
    expect(entry?.publisherChatId).toBe(1n);
  });

  it("findByGiftId returns null for an unknown id", async () => {
    expect(await store.findByGiftId("does-not-exist")).toBeNull();
  });

  it("findByPublisherChatId returns every catalog gift for that chat", async () => {
    const entries = await store.findByPublisherChatId(1n);
    expect(entries.map((e) => e.giftId).sort()).toEqual(["g1", "g2"]);
  });

  it("findByPublisherChatId does not match null publisherChatId", async () => {
    const entries = await store.findByPublisherChatId(0n);
    expect(entries).toEqual([]);
  });

  it("findByPublisherChatId returns empty for a chat with no gifts", async () => {
    expect(await store.findByPublisherChatId(9999n)).toEqual([]);
  });
});

describe("in-memory GiftCatalogStore — oldestRefreshedAt", () => {
  it("returns null when the store is empty", async () => {
    const store = createInMemoryGiftCatalogStore();
    expect(await store.oldestRefreshedAt()).toBeNull();
  });

  it("returns the minimum lastRefreshedAt across all entries", async () => {
    const store = createInMemoryGiftCatalogStore();
    await store.upsertEntry(baseInput({ giftId: "a", observedAt: new Date("2026-05-10Z") }));
    await store.upsertEntry(baseInput({ giftId: "b", observedAt: new Date("2026-05-12Z") }));
    await store.upsertEntry(baseInput({ giftId: "c", observedAt: new Date("2026-05-05Z") }));

    const oldest = await store.oldestRefreshedAt();
    expect(oldest?.toISOString()).toBe("2026-05-05T00:00:00.000Z");
  });
});
