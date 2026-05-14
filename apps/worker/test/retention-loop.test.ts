import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@tonshield/logger";
import {
  createInMemoryTelegramEntityStore,
  type TelegramEntitySnapshotInput,
} from "@tonshield/storage";
import { startSnapshotRetentionLoop } from "../src/retention-loop.ts";

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

const baseSnapshot = (
  overrides: Partial<TelegramEntitySnapshotInput> = {},
): TelegramEntitySnapshotInput => ({
  entityId: 1n,
  entityKind: "channel",
  observedAt: new Date("2024-01-01T00:00:00Z"),
  username: "x",
  activeUsernames: null,
  displayName: null,
  bio: null,
  photoFileUniqueId: null,
  isPremium: null,
  memberCount: null,
  isBot: false,
  source: "getChat",
  raw: null,
  ...overrides,
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("startSnapshotRetentionLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes snapshots older than `retentionMs` past `now` on the first tick", async () => {
    const store = createInMemoryTelegramEntityStore();
    // Two old, one fresh.
    await store.recordSnapshot(
      baseSnapshot({ entityId: 1n, observedAt: new Date("2023-01-01T00:00:00Z") }),
    );
    await store.recordSnapshot(
      baseSnapshot({ entityId: 2n, observedAt: new Date("2023-06-01T00:00:00Z") }),
    );
    await store.recordSnapshot(
      baseSnapshot({ entityId: 3n, observedAt: new Date("2026-05-14T00:00:00Z") }),
    );

    const sched = fakeSchedule();
    const loop = startSnapshotRetentionLoop({
      store,
      logger: silentLogger,
      intervalMs: 24 * 60 * 60 * 1000,
      retentionMs: 365 * MS_PER_DAY,
      maxRowsPerRun: 1000,
      schedule: { setInterval: sched.setInterval, clearInterval: sched.clearInterval },
      now: () => new Date("2026-05-14T00:00:00Z"),
    });

    await loop.currentTick();
    expect(await store.recentSnapshots(1n, 10)).toHaveLength(0);
    expect(await store.recentSnapshots(2n, 10)).toHaveLength(0);
    expect(await store.recentSnapshots(3n, 10)).toHaveLength(1);
    loop.stop();
  });

  it("respects maxRowsPerRun and resumes on the next tick", async () => {
    const store = createInMemoryTelegramEntityStore();
    for (let i = 0; i < 4; i++) {
      await store.recordSnapshot(
        baseSnapshot({
          entityId: BigInt(i + 1),
          observedAt: new Date(`2023-0${String(i + 1)}-01T00:00:00Z`),
        }),
      );
    }

    const sched = fakeSchedule();
    const loop = startSnapshotRetentionLoop({
      store,
      logger: silentLogger,
      intervalMs: 24 * 60 * 60 * 1000,
      retentionMs: 1 * MS_PER_DAY,
      maxRowsPerRun: 2,
      schedule: { setInterval: sched.setInterval, clearInterval: sched.clearInterval },
      now: () => new Date("2026-05-14T00:00:00Z"),
    });

    await loop.currentTick();
    // First two oldest gone.
    expect(await store.recentSnapshots(1n, 10)).toHaveLength(0);
    expect(await store.recentSnapshots(2n, 10)).toHaveLength(0);
    expect(await store.recentSnapshots(3n, 10)).toHaveLength(1);
    expect(await store.recentSnapshots(4n, 10)).toHaveLength(1);

    sched.fire();
    await loop.currentTick();
    // Now the remaining two are also gone.
    expect(await store.recentSnapshots(3n, 10)).toHaveLength(0);
    expect(await store.recentSnapshots(4n, 10)).toHaveLength(0);

    loop.stop();
  });

  it("keeps running after a transient store error", async () => {
    const store = createInMemoryTelegramEntityStore();
    await store.recordSnapshot(baseSnapshot({ observedAt: new Date("2023-01-01T00:00:00Z") }));

    let firstCall = true;
    const wrappedStore = {
      ...store,
      pruneSnapshots: vi.fn(async (args: { cutoff: Date; maxRows: number }) => {
        if (firstCall) {
          firstCall = false;
          throw new Error("transient db error");
        }
        return store.pruneSnapshots(args);
      }),
    };

    const sched = fakeSchedule();
    const loop = startSnapshotRetentionLoop({
      store: wrappedStore,
      logger: silentLogger,
      intervalMs: 24 * 60 * 60 * 1000,
      retentionMs: 1 * MS_PER_DAY,
      maxRowsPerRun: 100,
      schedule: { setInterval: sched.setInterval, clearInterval: sched.clearInterval },
      now: () => new Date("2026-05-14T00:00:00Z"),
    });

    // First tick threw; row should still be present.
    await loop.currentTick();
    expect(await store.recentSnapshots(1n, 10)).toHaveLength(1);

    // Second tick succeeds.
    sched.fire();
    await loop.currentTick();
    expect(await store.recentSnapshots(1n, 10)).toHaveLength(0);

    loop.stop();
  });

  it("stop() clears the interval", async () => {
    const store = createInMemoryTelegramEntityStore();
    const sched = fakeSchedule();
    const loop = startSnapshotRetentionLoop({
      store,
      logger: silentLogger,
      intervalMs: 24 * 60 * 60 * 1000,
      retentionMs: 365 * MS_PER_DAY,
      maxRowsPerRun: 100,
      schedule: { setInterval: sched.setInterval, clearInterval: sched.clearInterval },
    });

    await loop.currentTick();
    loop.stop();
    expect(sched.cleared()).toBe(true);
  });
});
