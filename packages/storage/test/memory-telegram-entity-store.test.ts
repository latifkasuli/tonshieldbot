import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryTelegramEntityStore } from "../src/memory/telegram-entity-store.ts";
import type {
  TelegramEntitySnapshotInput,
  TelegramEntityStore,
} from "../src/interfaces/telegram-entity-store.ts";

const baseInput = (
  overrides: Partial<TelegramEntitySnapshotInput> = {},
): TelegramEntitySnapshotInput => ({
  entityId: 12345n,
  entityKind: "channel",
  observedAt: new Date("2026-05-10T00:00:00Z"),
  username: "exampleproject",
  activeUsernames: null,
  displayName: "Example Project",
  bio: null,
  photoFileUniqueId: null,
  isPremium: null,
  memberCount: 1000,
  isBot: false,
  source: "getChat",
  raw: null,
  ...overrides,
});

describe("in-memory TelegramEntityStore — recordSnapshot", () => {
  let store: TelegramEntityStore;

  beforeEach(() => {
    store = createInMemoryTelegramEntityStore();
  });

  it("inserts a first-time snapshot and returns previous: null", async () => {
    const result = await store.recordSnapshot(baseInput());

    expect(result.inserted).toBe(true);
    expect(result.previous).toBeNull();
    expect(result.snapshot.entityId).toBe(12345n);
    expect(result.snapshot.username).toBe("exampleproject");
  });

  it("inserts a second snapshot when content differs from previous", async () => {
    await store.recordSnapshot(baseInput());

    const result = await store.recordSnapshot(
      baseInput({
        observedAt: new Date("2026-05-11T00:00:00Z"),
        username: "exampleproject_v2",
      }),
    );

    expect(result.inserted).toBe(true);
    expect(result.previous?.username).toBe("exampleproject");
    expect(result.snapshot.username).toBe("exampleproject_v2");
  });

  it("suppresses an identical re-snapshot within the cooldown window", async () => {
    await store.recordSnapshot(baseInput(), { cooldownMs: 60_000 });

    const result = await store.recordSnapshot(
      baseInput({ observedAt: new Date("2026-05-10T00:00:30Z") }),
      { cooldownMs: 60_000 },
    );

    expect(result.inserted).toBe(false);
    // The returned snapshot is the previously-stored one.
    expect(result.snapshot.observedAt.toISOString()).toBe("2026-05-10T00:00:00.000Z");
  });

  it("inserts a re-snapshot after the cooldown window even if content is identical", async () => {
    await store.recordSnapshot(baseInput(), { cooldownMs: 60_000 });

    const result = await store.recordSnapshot(
      baseInput({ observedAt: new Date("2026-05-10T00:02:00Z") }),
      { cooldownMs: 60_000 },
    );

    expect(result.inserted).toBe(true);
  });

  it("inserts a re-snapshot within cooldown when content differs (cooldown is content-aware)", async () => {
    // Cooldown suppression is ONLY for identical content. A real change
    // within the window should still record so we don't miss username
    // pivots that happen quickly.
    await store.recordSnapshot(baseInput(), { cooldownMs: 60_000 });

    const result = await store.recordSnapshot(
      baseInput({
        observedAt: new Date("2026-05-10T00:00:10Z"),
        username: "scammer",
      }),
      { cooldownMs: 60_000 },
    );

    expect(result.inserted).toBe(true);
    expect(result.snapshot.username).toBe("scammer");
  });
});

describe("in-memory TelegramEntityStore — latestSnapshot / recentSnapshots", () => {
  it("latestSnapshot returns null when no snapshot exists", async () => {
    const store = createInMemoryTelegramEntityStore();
    expect(await store.latestSnapshot(999n)).toBeNull();
  });

  it("latestSnapshot returns the most-recent record", async () => {
    const store = createInMemoryTelegramEntityStore();
    await store.recordSnapshot(baseInput());
    await store.recordSnapshot(
      baseInput({
        observedAt: new Date("2026-05-11T00:00:00Z"),
        username: "renamed",
      }),
    );

    const latest = await store.latestSnapshot(12345n);
    expect(latest?.username).toBe("renamed");
  });

  it("recentSnapshots returns newest-first, capped by limit", async () => {
    const store = createInMemoryTelegramEntityStore();
    await store.recordSnapshot(baseInput({ observedAt: new Date("2026-05-10T00:00:00Z") }));
    await store.recordSnapshot(
      baseInput({ observedAt: new Date("2026-05-11T00:00:00Z"), username: "v2" }),
    );
    await store.recordSnapshot(
      baseInput({ observedAt: new Date("2026-05-12T00:00:00Z"), username: "v3" }),
    );

    const recent = await store.recentSnapshots(12345n, 2);
    expect(recent.map((s) => s.username)).toEqual(["v3", "v2"]);
  });
});

describe("in-memory TelegramEntityStore — usernameHistory", () => {
  it("returns one binding per distinct username run, newest-first", async () => {
    const store = createInMemoryTelegramEntityStore();
    await store.recordSnapshot(baseInput({ observedAt: new Date("2026-01-01T00:00:00Z") }));
    await store.recordSnapshot(
      baseInput({
        observedAt: new Date("2026-02-01T00:00:00Z"),
        // Same username — same binding run.
      }),
    );
    await store.recordSnapshot(
      baseInput({
        observedAt: new Date("2026-03-01T00:00:00Z"),
        username: "exampleproject_v2",
      }),
    );
    await store.recordSnapshot(
      baseInput({
        observedAt: new Date("2026-04-01T00:00:00Z"),
        username: "scammer",
      }),
    );

    const history = await store.usernameHistory(12345n);

    expect(history.map((b) => b.username)).toEqual([
      "scammer",
      "exampleproject_v2",
      "exampleproject",
    ]);
    expect(history[0]?.boundTo).toBeNull(); // current
    expect(history[1]?.boundTo?.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(history[2]?.boundTo?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("in-memory TelegramEntityStore — findEntityByUsername", () => {
  it("returns only the entity currently bound to a username, not historical holders", async () => {
    const store = createInMemoryTelegramEntityStore();
    await store.recordSnapshot(baseInput({ username: "oldhandle" }));
    await store.recordSnapshot(
      baseInput({
        observedAt: new Date("2026-05-11T00:00:00Z"),
        username: "newhandle",
      }),
    );

    expect(await store.findEntityByUsername("oldhandle")).toBeNull();
    expect(await store.findEntityByUsername("newhandle")).toMatchObject({ id: 12345n });
  });
});
