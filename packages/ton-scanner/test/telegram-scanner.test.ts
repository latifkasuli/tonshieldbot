import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryTelegramEntityStore } from "@tonshield/storage";
import type { TelegramEntityStore } from "@tonshield/storage";
import {
  resolveById,
  resolveChannelOrSupergroup,
  resolveUserOrBot,
  type TelegramIntelClient,
} from "@tonshield/telegram-intel";
import { scanTelegramEntity } from "../src/telegram/scanner.ts";

// Boundary-mock the resolver functions. The scanner orchestrates them;
// their internals are covered by entity-resolver and config tests in
// `@tonshield/telegram-intel`.
vi.mock("@tonshield/telegram-intel", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tonshield/telegram-intel")>();
  return {
    ...original,
    resolveChannelOrSupergroup: vi.fn(),
    resolveById: vi.fn(),
    resolveUserOrBot: vi.fn(),
  };
});

const mockedResolveChannel = vi.mocked(resolveChannelOrSupergroup);
const mockedResolveById = vi.mocked(resolveById);
const mockedResolveUserOrBot = vi.mocked(resolveUserOrBot);

const enabledClient: TelegramIntelClient = {
  enabled: true,
  apiBaseUrl: "https://api.telegram.org",
  raw: {} as TelegramIntelClient["raw"],
};
const disabledClient: TelegramIntelClient = {
  enabled: false,
  apiBaseUrl: "https://api.telegram.org",
  raw: {} as TelegramIntelClient["raw"],
};

let store: TelegramEntityStore;

const ruleIds = (findings: readonly { ruleId: string }[]): readonly string[] =>
  findings.map((f) => f.ruleId);

beforeEach(() => {
  vi.clearAllMocks();
  store = createInMemoryTelegramEntityStore();
});

const buildResolvedChannel = (overrides: Partial<{ username: string; id: bigint }> = {}) => ({
  status: "ok" as const,
  entity: {
    id: overrides.id ?? 100200300n,
    kind: "channel" as const,
    username: overrides.username ?? "exampleproject",
    activeUsernames: null,
    displayName: "Example Project",
    bio: null,
    photoFileUniqueId: null,
    isPremium: null,
    memberCount: null,
    isBot: false,
    raw: {} as Readonly<Record<string, unknown>>,
  },
});

// ── degradation paths ───────────────────────────────────────────────────────

describe("scanTelegramEntity degradation paths", () => {
  it("emits TELEGRAM_BOT_API_NOT_CONFIGURED when no client is provided", async () => {
    const result = await scanTelegramEntity(undefined, store, {
      channelOrSupergroupHandle: "exampleproject",
    });

    expect(ruleIds(result.findings)).toEqual(["TELEGRAM_BOT_API_NOT_CONFIGURED"]);
    expect(mockedResolveChannel).not.toHaveBeenCalled();
  });

  it("emits TELEGRAM_BOT_API_NOT_CONFIGURED when the client is disabled", async () => {
    const result = await scanTelegramEntity(disabledClient, store, {
      channelOrSupergroupHandle: "exampleproject",
    });

    expect(ruleIds(result.findings)).toEqual(["TELEGRAM_BOT_API_NOT_CONFIGURED"]);
  });
});

// ── DoD #4: cold user/bot @handle ───────────────────────────────────────────
//
// Per m3-design.md §1.2: Bot API does not support cold resolution of user/
// bot @handles. The scanner must surface this as a not-resolvable finding
// with the correct reason discriminator.

describe("scanTelegramEntity — cold user/bot handle path", () => {
  it("emits TELEGRAM_ENTITY_NOT_RESOLVABLE with reason=user_or_bot_handle_requires_prior_context", async () => {
    mockedResolveUserOrBot.mockReturnValue({
      status: "not_resolvable",
      reason: "user_or_bot_handle_requires_prior_context",
      description: "Bot API does not support cold resolution of user/bot @handle 'somebot'",
    });

    const result = await scanTelegramEntity(enabledClient, store, {
      userOrBotHandle: "somebot",
    });

    expect(ruleIds(result.findings)).toEqual(["TELEGRAM_ENTITY_NOT_RESOLVABLE"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      reason: "user_or_bot_handle_requires_prior_context",
    });
  });
});

// ── DoD #1, #2, #3: snapshot recording + cooldown + username-change ─────────

describe("scanTelegramEntity — channel/supergroup snapshot path", () => {
  it("records a snapshot for a public channel handle on first observation", async () => {
    mockedResolveChannel.mockResolvedValue(buildResolvedChannel());

    const result = await scanTelegramEntity(
      enabledClient,
      store,
      { channelOrSupergroupHandle: "exampleproject" },
      { now: new Date("2026-05-10T00:00:00Z") },
    );

    expect(result.findings).toEqual([]);
    const latest = await store.latestSnapshot(100200300n);
    expect(latest?.username).toBe("exampleproject");
    expect(latest?.source).toBe("getChat");
  });

  it("suppresses an identical re-scan within the cooldown window (no new snapshot)", async () => {
    mockedResolveChannel.mockResolvedValue(buildResolvedChannel());

    await scanTelegramEntity(
      enabledClient,
      store,
      { channelOrSupergroupHandle: "exampleproject" },
      { now: new Date("2026-05-10T00:00:00Z") },
    );

    await scanTelegramEntity(
      enabledClient,
      store,
      { channelOrSupergroupHandle: "exampleproject" },
      { now: new Date("2026-05-10T00:01:00Z") },
    );

    const recent = await store.recentSnapshots(100200300n, 10);
    expect(recent).toHaveLength(1);
  });

  it("emits TELEGRAM_USERNAME_RECENTLY_CHANGED when the new observation has a different username", async () => {
    mockedResolveChannel.mockResolvedValueOnce(
      buildResolvedChannel({ username: "exampleproject" }),
    );
    await scanTelegramEntity(
      enabledClient,
      store,
      { channelOrSupergroupHandle: "exampleproject" },
      { now: new Date("2026-05-10T00:00:00Z") },
    );

    mockedResolveChannel.mockResolvedValueOnce(buildResolvedChannel({ username: "scammer" }));
    const result = await scanTelegramEntity(
      enabledClient,
      store,
      { channelOrSupergroupHandle: "scammer" },
      { now: new Date("2026-05-11T00:00:00Z") },
    );

    expect(ruleIds(result.findings)).toEqual(["TELEGRAM_USERNAME_RECENTLY_CHANGED"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      entityId: "100200300",
      previousUsername: "exampleproject",
      currentUsername: "scammer",
    });
  });

  it("does not emit TELEGRAM_USERNAME_RECENTLY_CHANGED on first observation (no prior to diff)", async () => {
    mockedResolveChannel.mockResolvedValue(buildResolvedChannel());

    const result = await scanTelegramEntity(
      enabledClient,
      store,
      { channelOrSupergroupHandle: "exampleproject" },
      { now: new Date("2026-05-10T00:00:00Z") },
    );

    expect(ruleIds(result.findings)).not.toContain("TELEGRAM_USERNAME_RECENTLY_CHANGED");
  });

  it("emits TELEGRAM_ENTITY_NOT_RESOLVABLE with channel_or_supergroup_not_found when getChat fails", async () => {
    mockedResolveChannel.mockResolvedValue({
      status: "not_resolvable",
      reason: "channel_or_supergroup_not_found",
      description: "Bad Request: chat not found",
    });

    const result = await scanTelegramEntity(enabledClient, store, {
      channelOrSupergroupHandle: "doesnotexist",
    });

    expect(ruleIds(result.findings)).toEqual(["TELEGRAM_ENTITY_NOT_RESOLVABLE"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      reason: "channel_or_supergroup_not_found",
    });
  });

  it("classifies a Bot API 429 as TELEGRAM_BOT_API_RATE_LIMITED", async () => {
    mockedResolveChannel.mockResolvedValue({
      status: "failed",
      failure: { status: "rate_limited", httpStatus: 429, retryAfter: 5 },
    });

    const result = await scanTelegramEntity(enabledClient, store, {
      channelOrSupergroupHandle: "exampleproject",
    });

    expect(ruleIds(result.findings)).toEqual(["TELEGRAM_BOT_API_RATE_LIMITED"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      httpStatus: 429,
      retryAfter: 5,
    });
  });
});

// ── DoD #5: forwarded message origin snapshot ───────────────────────────────

describe("scanTelegramEntity — forwarded message path", () => {
  it("snapshots a forwarded bot's User without calling Bot API", async () => {
    const forwardedBot = {
      id: 999000111n,
      kind: "bot" as const,
      username: "somebot",
      activeUsernames: null,
      displayName: "Some Bot",
      bio: null,
      photoFileUniqueId: null,
      isPremium: null,
      memberCount: null,
      isBot: true,
      raw: {} as Readonly<Record<string, unknown>>,
    };

    const result = await scanTelegramEntity(
      enabledClient,
      store,
      { forwardOriginUser: forwardedBot },
      { now: new Date("2026-05-10T00:00:00Z") },
    );

    expect(result.findings).toEqual([]);
    expect(mockedResolveChannel).not.toHaveBeenCalled();
    expect(mockedResolveById).not.toHaveBeenCalled();

    const latest = await store.latestSnapshot(999000111n);
    expect(latest?.username).toBe("somebot");
    expect(latest?.isBot).toBe(true);
    expect(latest?.source).toBe("forward");
  });

  it("fires TELEGRAM_USERNAME_RECENTLY_CHANGED on a forwarded snapshot when the username has changed since last observation", async () => {
    // First sighting via a forward (records baseline).
    await scanTelegramEntity(
      enabledClient,
      store,
      {
        forwardOriginUser: {
          id: 999000111n,
          kind: "bot",
          username: "originalbot",
          activeUsernames: null,
          displayName: "Bot",
          bio: null,
          photoFileUniqueId: null,
          isPremium: null,
          memberCount: null,
          isBot: true,
          raw: {},
        },
      },
      { now: new Date("2026-05-10T00:00:00Z") },
    );

    // Second forward shows a renamed bot.
    const result = await scanTelegramEntity(
      enabledClient,
      store,
      {
        forwardOriginUser: {
          id: 999000111n,
          kind: "bot",
          username: "renamedbot",
          activeUsernames: null,
          displayName: "Bot",
          bio: null,
          photoFileUniqueId: null,
          isPremium: null,
          memberCount: null,
          isBot: true,
          raw: {},
        },
      },
      { now: new Date("2026-05-11T00:00:00Z") },
    );

    expect(ruleIds(result.findings)).toEqual(["TELEGRAM_USERNAME_RECENTLY_CHANGED"]);
  });
});
