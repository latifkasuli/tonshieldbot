import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@tonshield/logger";
import { createInMemoryGiftCatalogStore } from "@tonshield/storage";
import type { TelegramIntelClient } from "@tonshield/telegram-intel";
import { startGiftCatalogRefreshLoop } from "../src/refresh-loop.ts";

const buildClient = (
  getAvailableGifts: ReturnType<typeof vi.fn>,
  enabled = true,
): TelegramIntelClient => ({
  enabled,
  apiBaseUrl: "https://api.telegram.org",
  raw: { getAvailableGifts } as unknown as TelegramIntelClient["raw"],
});

const sampleGift = (id: string) => ({
  id,
  sticker: { file_unique_id: `s-${id}` },
  star_count: 25,
});

interface FakeSchedule {
  readonly setInterval: typeof setInterval;
  readonly clearInterval: typeof clearInterval;
  fire(): void;
  readonly cleared: () => boolean;
}

const fakeSchedule = (): FakeSchedule => {
  let cb: (() => void) | null = null;
  let cleared = false;
  return {
    // Lying about the type — vitest doesn't run the real timer; only `fire()` does.
    setInterval: ((handler: () => void) => {
      cb = handler;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
    clearInterval: () => {
      cleared = true;
    },
    fire: () => {
      cb?.();
    },
    cleared: () => cleared,
  };
};

const silentLogger = createLogger({
  service: "tonshield-worker-test",
  level: "silent",
  pretty: false,
});

describe("startGiftCatalogRefreshLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls refreshGiftCatalog once immediately on start", async () => {
    const store = createInMemoryGiftCatalogStore();
    const getAvailableGifts = vi.fn().mockResolvedValue({ gifts: [sampleGift("g1")] });
    const sched = fakeSchedule();

    const loop = startGiftCatalogRefreshLoop({
      client: buildClient(getAvailableGifts),
      store,
      logger: silentLogger,
      intervalMs: 60_000,
      schedule: { setInterval: sched.setInterval, clearInterval: sched.clearInterval },
    });

    await loop.currentTick();
    expect(getAvailableGifts).toHaveBeenCalledTimes(1);
    expect(await store.findByGiftId("g1")).not.toBeNull();
    loop.stop();
  });

  it("fires again on each interval tick", async () => {
    const store = createInMemoryGiftCatalogStore();
    const getAvailableGifts = vi.fn().mockResolvedValue({ gifts: [sampleGift("g1")] });
    const sched = fakeSchedule();

    const loop = startGiftCatalogRefreshLoop({
      client: buildClient(getAvailableGifts),
      store,
      logger: silentLogger,
      intervalMs: 60_000,
      schedule: { setInterval: sched.setInterval, clearInterval: sched.clearInterval },
    });

    await loop.currentTick();
    sched.fire();
    await loop.currentTick();
    sched.fire();
    await loop.currentTick();

    expect(getAvailableGifts).toHaveBeenCalledTimes(3);
    loop.stop();
  });

  it("keeps running after a transient Bot API failure", async () => {
    const store = createInMemoryGiftCatalogStore();
    const getAvailableGifts = vi
      .fn()
      .mockRejectedValueOnce({ error_code: 500 })
      .mockResolvedValueOnce({ gifts: [sampleGift("g1")] });
    const sched = fakeSchedule();

    const loop = startGiftCatalogRefreshLoop({
      client: buildClient(getAvailableGifts),
      store,
      logger: silentLogger,
      intervalMs: 60_000,
      schedule: { setInterval: sched.setInterval, clearInterval: sched.clearInterval },
    });

    await loop.currentTick();
    expect(await store.findByGiftId("g1")).toBeNull();

    sched.fire();
    await loop.currentTick();
    expect(await store.findByGiftId("g1")).not.toBeNull();

    loop.stop();
  });

  it("stop() clears the interval and prevents future ticks", async () => {
    const store = createInMemoryGiftCatalogStore();
    const getAvailableGifts = vi.fn().mockResolvedValue({ gifts: [] });
    const sched = fakeSchedule();

    const loop = startGiftCatalogRefreshLoop({
      client: buildClient(getAvailableGifts),
      store,
      logger: silentLogger,
      intervalMs: 60_000,
      schedule: { setInterval: sched.setInterval, clearInterval: sched.clearInterval },
    });

    await loop.currentTick();
    loop.stop();
    expect(sched.cleared()).toBe(true);
  });
});
