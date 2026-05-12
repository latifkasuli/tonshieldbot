import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryTelegramEntityStore } from "@tonshield/storage";
import type { TelegramEntityStore } from "@tonshield/storage";
import {
  resolveById,
  resolveChannelOrSupergroup,
  resolveUserOrBot,
  type BrandWatchlistEntry,
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

// ── M3 PR-3: handle / display-name impersonation ───────────────────────────
//
// These pin the rule emissions for `TELEGRAM_HANDLE_IMPERSONATES_PROJECT`
// and `TELEGRAM_DISPLAY_NAME_HOMOGLYPH`. The matcher itself is covered by
// unit tests in `@tonshield/telegram-intel/test/handle-similarity.test.ts`;
// here we only assert the scanner orchestrates it correctly and the
// evidence shape lands as the design doc specifies.

const impersonationWatchlist: readonly BrandWatchlistEntry[] = [
  {
    brand: "Tonkeeper",
    category: "wallet",
    matchKeys: ["tonkeeper", "tonkeeper_support"],
    legitimateHandles: ["tonkeeper"],
  },
  {
    brand: "Binance",
    category: "exchange",
    matchKeys: ["binance", "binancesupport"],
    legitimateHandles: [],
  },
];

describe("scanTelegramEntity — handle impersonation", () => {
  it("fires TELEGRAM_HANDLE_IMPERSONATES_PROJECT on a cold-resolution user/bot handle that matches the watchlist", async () => {
    // User submits `@tonkeeper_support` cold. Bot API can't resolve it,
    // so we emit TELEGRAM_ENTITY_NOT_RESOLVABLE. But the impersonation
    // check runs BEFORE resolution so the user still sees the brand
    // signal — that's the whole point.
    mockedResolveUserOrBot.mockReturnValue({
      status: "not_resolvable",
      reason: "user_or_bot_handle_requires_prior_context",
      description: null,
    });

    const result = await scanTelegramEntity(
      enabledClient,
      store,
      { userOrBotHandle: "tonkeeper_support", watchlist: impersonationWatchlist },
      { now: new Date("2026-05-11T00:00:00Z") },
    );

    expect(ruleIds(result.findings)).toContain("TELEGRAM_HANDLE_IMPERSONATES_PROJECT");
    expect(ruleIds(result.findings)).toContain("TELEGRAM_ENTITY_NOT_RESOLVABLE");
    const impersonation = result.findings.find(
      (f) => f.ruleId === "TELEGRAM_HANDLE_IMPERSONATES_PROJECT",
    );
    expect(impersonation?.evidence).toMatchObject({
      field: "handle",
      matchedBrand: "Tonkeeper",
      strength: "exact",
    });
  });

  it("does NOT fire TELEGRAM_HANDLE_IMPERSONATES_PROJECT for a legitimate brand handle", async () => {
    mockedResolveUserOrBot.mockReturnValue({
      status: "not_resolvable",
      reason: "user_or_bot_handle_requires_prior_context",
      description: null,
    });

    const result = await scanTelegramEntity(
      enabledClient,
      store,
      { userOrBotHandle: "tonkeeper", watchlist: impersonationWatchlist },
      { now: new Date("2026-05-11T00:00:00Z") },
    );

    expect(ruleIds(result.findings)).not.toContain("TELEGRAM_HANDLE_IMPERSONATES_PROJECT");
  });

  it("fires TELEGRAM_HANDLE_IMPERSONATES_PROJECT on a Cyrillic-homoglyph handle that survives even when Bot API is disabled", async () => {
    // Even without a Bot API token, we should still surface the
    // impersonation signal from the candidate handle text alone.
    const result = await scanTelegramEntity(
      undefined,
      store,
      { userOrBotHandle: "Тоnkeeper", watchlist: impersonationWatchlist },
      { now: new Date("2026-05-11T00:00:00Z") },
    );

    expect(ruleIds(result.findings)).toContain("TELEGRAM_HANDLE_IMPERSONATES_PROJECT");
    expect(ruleIds(result.findings)).toContain("TELEGRAM_BOT_API_NOT_CONFIGURED");
  });

  it("fires TELEGRAM_HANDLE_IMPERSONATES_PROJECT on resolved username when entity has a typo-handle", async () => {
    mockedResolveChannel.mockResolvedValue({
      status: "ok",
      entity: {
        id: 100200300n,
        kind: "channel",
        username: "tonkeepar",
        activeUsernames: null,
        displayName: "Tonkeeper",
        bio: null,
        photoFileUniqueId: null,
        isPremium: null,
        memberCount: null,
        isBot: false,
        raw: {},
      },
    });

    const result = await scanTelegramEntity(
      enabledClient,
      store,
      { channelOrSupergroupHandle: "tonkeepar", watchlist: impersonationWatchlist },
      { now: new Date("2026-05-11T00:00:00Z") },
    );

    expect(ruleIds(result.findings)).toContain("TELEGRAM_HANDLE_IMPERSONATES_PROJECT");
    const finding = result.findings.find(
      (f) => f.ruleId === "TELEGRAM_HANDLE_IMPERSONATES_PROJECT",
    );
    expect(finding?.evidence).toMatchObject({
      matchedBrand: "Tonkeeper",
      strength: "near",
      distance: 1,
    });
  });

  it("deduplicates TELEGRAM_HANDLE_IMPERSONATES_PROJECT when input handle and resolved username both match", async () => {
    mockedResolveChannel.mockResolvedValue({
      status: "ok",
      entity: {
        id: 100200300n,
        kind: "channel",
        username: "tonkeeper_support",
        activeUsernames: null,
        displayName: "Tonkeeper",
        bio: null,
        photoFileUniqueId: null,
        isPremium: null,
        memberCount: null,
        isBot: false,
        raw: {},
      },
    });

    const result = await scanTelegramEntity(
      enabledClient,
      store,
      { channelOrSupergroupHandle: "tonkeeper_support", watchlist: impersonationWatchlist },
      { now: new Date("2026-05-11T00:00:00Z") },
    );

    const impersonationFindings = result.findings.filter(
      (f) => f.ruleId === "TELEGRAM_HANDLE_IMPERSONATES_PROJECT",
    );
    expect(impersonationFindings).toHaveLength(1);
  });
});

describe("scanTelegramEntity — display name homoglyph", () => {
  it("fires TELEGRAM_DISPLAY_NAME_HOMOGLYPH when display name is a Cyrillic homoglyph of a brand", async () => {
    mockedResolveChannel.mockResolvedValue({
      status: "ok",
      entity: {
        id: 100200300n,
        kind: "channel",
        username: "fake_tonkeeper_news_777",
        activeUsernames: null,
        // Cyrillic Т and о — visually "Tonkeeper".
        displayName: "Тоnkeeper",
        bio: null,
        photoFileUniqueId: null,
        isPremium: null,
        memberCount: null,
        isBot: false,
        raw: {},
      },
    });

    const result = await scanTelegramEntity(
      enabledClient,
      store,
      {
        channelOrSupergroupHandle: "fake_tonkeeper_news_777",
        watchlist: impersonationWatchlist,
      },
      { now: new Date("2026-05-11T00:00:00Z") },
    );

    expect(ruleIds(result.findings)).toContain("TELEGRAM_DISPLAY_NAME_HOMOGLYPH");
    const finding = result.findings.find((f) => f.ruleId === "TELEGRAM_DISPLAY_NAME_HOMOGLYPH");
    expect(finding?.evidence).toMatchObject({
      field: "display_name",
      matchedBrand: "Tonkeeper",
      strength: "exact",
    });
  });

  it("does NOT fire TELEGRAM_DISPLAY_NAME_HOMOGLYPH for the legitimate brand handle even when display name matches", async () => {
    mockedResolveChannel.mockResolvedValue({
      status: "ok",
      entity: {
        id: 100200300n,
        kind: "channel",
        username: "tonkeeper",
        activeUsernames: null,
        displayName: "Tonkeeper",
        bio: null,
        photoFileUniqueId: null,
        isPremium: null,
        memberCount: null,
        isBot: false,
        raw: {},
      },
    });

    const result = await scanTelegramEntity(
      enabledClient,
      store,
      { channelOrSupergroupHandle: "tonkeeper", watchlist: impersonationWatchlist },
      { now: new Date("2026-05-11T00:00:00Z") },
    );

    expect(ruleIds(result.findings)).not.toContain("TELEGRAM_DISPLAY_NAME_HOMOGLYPH");
    expect(ruleIds(result.findings)).not.toContain("TELEGRAM_HANDLE_IMPERSONATES_PROJECT");
  });

  it("prefers the strongest match across display_name and bio fields (single finding only)", async () => {
    mockedResolveChannel.mockResolvedValue({
      status: "ok",
      entity: {
        id: 100200300n,
        kind: "channel",
        username: "scam_channel_xyz",
        activeUsernames: null,
        // Display name a typo-distance away from Binance.
        displayName: "Binancce",
        // Bio is an exact skeleton-match of Tonkeeper.
        bio: "Official Тоnkeeper support channel",
        photoFileUniqueId: null,
        isPremium: null,
        memberCount: null,
        isBot: false,
        raw: {},
      },
    });

    const result = await scanTelegramEntity(
      enabledClient,
      store,
      {
        channelOrSupergroupHandle: "scam_channel_xyz",
        watchlist: impersonationWatchlist,
      },
      { now: new Date("2026-05-11T00:00:00Z") },
    );

    const homoglyphFindings = result.findings.filter(
      (f) => f.ruleId === "TELEGRAM_DISPLAY_NAME_HOMOGLYPH",
    );
    expect(homoglyphFindings).toHaveLength(1);
    expect(homoglyphFindings[0]?.evidence).toMatchObject({
      field: "bio",
      matchedBrand: "Tonkeeper",
      matchedKey: "tonkeeper_support",
      strength: "exact",
    });
  });
});

// ── M3 PR-4: ID-age estimator + TELEGRAM_ENTITY_VERY_NEW ───────────────────
//
// The rule fires ONLY when paired with a tier-1 signal. Tests cover both
// directions: with-pairing fires; without-pairing suppressed; channel/
// supergroup deferred (no fire even with pairing, until a channel anchor
// table ships).

describe("scanTelegramEntity — TELEGRAM_ENTITY_VERY_NEW (PR-4)", () => {
  // A fresh-looking bot ID well past the anchor table's last entry.
  // The age estimator extrapolates it to a recent date.
  const FRESH_BOT_ID = 9_500_000_000n;
  // A clearly-old bot ID anchored in 2019.
  const OLD_BOT_ID = 925_396_585n;

  it("fires TELEGRAM_ENTITY_VERY_NEW when a fresh-id bot ALSO impersonates a brand", async () => {
    // Forward-origin path with an entity whose ID is post-anchor-table.
    const result = await scanTelegramEntity(
      enabledClient,
      store,
      {
        forwardOriginUser: {
          id: FRESH_BOT_ID,
          kind: "bot",
          username: "tonkeeper_support",
          activeUsernames: null,
          displayName: "Tonkeeper",
          bio: null,
          photoFileUniqueId: null,
          isPremium: null,
          memberCount: null,
          isBot: true,
          raw: {},
        },
        watchlist: impersonationWatchlist,
      },
      { now: new Date("2026-05-11T00:00:00Z") },
    );

    expect(ruleIds(result.findings)).toContain("TELEGRAM_HANDLE_IMPERSONATES_PROJECT");
    expect(ruleIds(result.findings)).toContain("TELEGRAM_ENTITY_VERY_NEW");
    const ageFinding = result.findings.find((f) => f.ruleId === "TELEGRAM_ENTITY_VERY_NEW");
    expect(ageFinding?.evidence).toMatchObject({
      entityId: FRESH_BOT_ID.toString(),
      entityKind: "bot",
    });
    expect(ageFinding?.evidence.pairedRuleIds as readonly string[]).toContain(
      "TELEGRAM_HANDLE_IMPERSONATES_PROJECT",
    );
  });

  it("does NOT fire TELEGRAM_ENTITY_VERY_NEW for a fresh-id bot without a paired tier-1 signal", async () => {
    // Same fresh ID, but the username is generic and doesn't match the
    // watchlist — no impersonation finding fires, so the age rule
    // should be suppressed.
    const result = await scanTelegramEntity(
      enabledClient,
      store,
      {
        forwardOriginUser: {
          id: FRESH_BOT_ID,
          kind: "bot",
          username: "generic_widget_bot",
          activeUsernames: null,
          displayName: "Widget",
          bio: null,
          photoFileUniqueId: null,
          isPremium: null,
          memberCount: null,
          isBot: true,
          raw: {},
        },
        watchlist: impersonationWatchlist,
      },
      { now: new Date("2026-05-11T00:00:00Z") },
    );

    expect(ruleIds(result.findings)).not.toContain("TELEGRAM_ENTITY_VERY_NEW");
  });

  it("does NOT fire TELEGRAM_ENTITY_VERY_NEW for an old-id bot even with impersonation", async () => {
    // Pairing condition met, but the age estimate is years old — rule
    // suppressed because the entity isn't actually new.
    const result = await scanTelegramEntity(
      enabledClient,
      store,
      {
        forwardOriginUser: {
          id: OLD_BOT_ID,
          kind: "bot",
          username: "tonkeeper_support",
          activeUsernames: null,
          displayName: "Tonkeeper",
          bio: null,
          photoFileUniqueId: null,
          isPremium: null,
          memberCount: null,
          isBot: true,
          raw: {},
        },
        watchlist: impersonationWatchlist,
      },
      { now: new Date("2026-05-11T00:00:00Z") },
    );

    expect(ruleIds(result.findings)).toContain("TELEGRAM_HANDLE_IMPERSONATES_PROJECT");
    expect(ruleIds(result.findings)).not.toContain("TELEGRAM_ENTITY_VERY_NEW");
  });

  it("does NOT fire TELEGRAM_ENTITY_VERY_NEW for channel/supergroup entities (PR-4 ships user/bot only)", async () => {
    // Channel resolution path with an impersonating username. The age
    // estimator's anchor table is user/bot only; channel ID counter is
    // separate. Suppress until a channel anchor table ships.
    mockedResolveChannel.mockResolvedValue({
      status: "ok",
      entity: {
        // Negative-form channel ID per Bot API. Magnitude similar to a
        // user ID just to exercise the kind-based gate.
        id: -1_009_500_000_000n,
        kind: "channel",
        username: "tonkeeper_support",
        activeUsernames: null,
        displayName: "Tonkeeper",
        bio: null,
        photoFileUniqueId: null,
        isPremium: null,
        memberCount: null,
        isBot: false,
        raw: {},
      },
    });

    const result = await scanTelegramEntity(
      enabledClient,
      store,
      { channelOrSupergroupHandle: "tonkeeper_support", watchlist: impersonationWatchlist },
      { now: new Date("2026-05-11T00:00:00Z") },
    );

    expect(ruleIds(result.findings)).toContain("TELEGRAM_HANDLE_IMPERSONATES_PROJECT");
    expect(ruleIds(result.findings)).not.toContain("TELEGRAM_ENTITY_VERY_NEW");
  });

  it("ID-age extrapolation past the last anchor produces a band='wide' / confidence='low' finding when paired", async () => {
    // Confirms the extrapolation path is exercised (id > max anchor).
    const result = await scanTelegramEntity(
      enabledClient,
      store,
      {
        forwardOriginUser: {
          id: 12_000_000_000n,
          kind: "bot",
          username: "tonkeeper_support",
          activeUsernames: null,
          displayName: "Tonkeeper",
          bio: null,
          photoFileUniqueId: null,
          isPremium: null,
          memberCount: null,
          isBot: true,
          raw: {},
        },
        watchlist: impersonationWatchlist,
      },
      { now: new Date("2026-05-11T00:00:00Z") },
    );

    const ageFinding = result.findings.find((f) => f.ruleId === "TELEGRAM_ENTITY_VERY_NEW");
    expect(ageFinding).toBeDefined();
    expect(ageFinding?.confidence).toBe("low");
    expect(ageFinding?.evidence).toMatchObject({ band: "wide", extrapolated: true });
  });
});
