import { describe, expect, it, vi } from "vitest";
import * as emulator from "@tonshield/ton-emulator";
import type { TonEmulatorClient } from "@tonshield/ton-emulator";
import { createInMemoryTelegramEntityStore } from "@tonshield/storage";
import type { TelegramIntelClient } from "@tonshield/telegram-intel";
import type { MtprotoIntelClient } from "@tonshield/telegram-intel/mtproto";
import { createBasicScan } from "../src/basic-scan.ts";

// Mock the emulator boundary so we can detect calls without making any
// HTTP requests. The static-malformed-skip path under test should never
// reach these — that's exactly what we're asserting.
vi.mock("@tonshield/ton-emulator", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tonshield/ton-emulator")>();

  return {
    ...original,
    emulateMessageToWallet: vi.fn(),
    fetchSenderMetadata: vi.fn(),
    buildExternalMessageBoc: vi.fn(),
  };
});

const SENDER_FRIENDLY = "UQAQxxpzxmEVU0Lu8U0zNTxBzXIWPvo263TIN1OQM9YvxsnV";
const RECIPIENT_FRIENDLY = "UQDNzlh0XSZdb5_Qrlx5QjyZHVAO74v5oMeVVrtF_5Vt1rIt";

const enabledEmulator: TonEmulatorClient = {
  enabled: true,
  baseUrl: "https://tonapi.io",
  raw: {} as TonEmulatorClient["raw"],
};

describe("createBasicScan composition of static + emulation paths", () => {
  it("emits TRANSACTION_MALFORMED_MESSAGE exactly once when static decode rejects malformed input", async () => {
    // Empty messages array → M1.5 static decoder emits
    // TRANSACTION_MALFORMED_MESSAGE. Without the skip, the emulation
    // scanner would emit the same rule a second time and double the score.
    const malformed = JSON.stringify({ from: SENDER_FRIENDLY, messages: [] });

    const report = await createBasicScan({
      rawInput: malformed,
      emulator: enabledEmulator,
    });

    const malformedFindings = report.findings.filter(
      (f) => f.ruleId === "TRANSACTION_MALFORMED_MESSAGE",
    );

    expect(malformedFindings).toHaveLength(1);
    expect(report.input.kind).toBe("transaction_json");
  });

  it("never invokes emulation when static decode rejects malformed input (no wasted TONAPI calls)", async () => {
    vi.mocked(emulator.fetchSenderMetadata).mockClear();
    vi.mocked(emulator.emulateMessageToWallet).mockClear();
    vi.mocked(emulator.buildExternalMessageBoc).mockClear();

    const malformed = JSON.stringify({
      from: SENDER_FRIENDLY,
      messages: [{ address: RECIPIENT_FRIENDLY }], // missing `amount`
    });

    await createBasicScan({
      rawInput: malformed,
      emulator: enabledEmulator,
    });

    expect(emulator.fetchSenderMetadata).not.toHaveBeenCalled();
    expect(emulator.emulateMessageToWallet).not.toHaveBeenCalled();
    expect(emulator.buildExternalMessageBoc).not.toHaveBeenCalled();
  });

  it("emits a single TRANSACTION_MALFORMED_MESSAGE for an empty messages array (was double-counted before this fix)", async () => {
    // Regression for the double-count concern raised in PR #17 review:
    // both static and emulation scanners structurally validate
    // `messages[]` and both emit TRANSACTION_MALFORMED_MESSAGE on empty.
    // Without skip, score doubled for one underlying defect.
    const malformed = JSON.stringify({ from: SENDER_FRIENDLY, messages: [] });

    const report = await createBasicScan({
      rawInput: malformed,
      emulator: enabledEmulator,
    });

    const total = report.findings.filter(
      (f) => f.ruleId === "TRANSACTION_MALFORMED_MESSAGE",
    ).length;

    expect(total).toBe(1);
  });
});

// ── M3 PR-2 review regressions ─────────────────────────────────────────────
//
// These pin the fixes for the three "silent clean report" failure modes
// identified in PR #22 review: nft links, no-handle telegram URLs, and
// missing snapshot store. All three should now surface
// TELEGRAM_INPUT_RECOGNISED_NOT_SCANNED with a `reason` discriminator
// rather than producing an empty findings array.

describe("createBasicScan — Telegram inputs that should never look 'clean' by accident", () => {
  it("routes bare @handles through getChat so public bot/user handles can resolve", async () => {
    const getChat = vi.fn().mockResolvedValue({
      id: 123456789,
      type: "private",
      username: "starhashrobot",
      first_name: "Star Hash",
      is_bot: true,
    });
    const telegramIntel: TelegramIntelClient = {
      enabled: true,
      apiBaseUrl: "https://api.telegram.org",
      raw: { getChat } as unknown as TelegramIntelClient["raw"],
    };
    const telegramEntities = createInMemoryTelegramEntityStore();

    const report = await createBasicScan({
      rawInput: "@starhashrobot",
      telegramIntel,
      telegramEntities,
    });

    expect(getChat).toHaveBeenCalledWith("@starhashrobot");
    expect(report.input.kind).toBe("telegram_handle");
    expect(report.findings.map((f) => f.ruleId)).not.toContain("TELEGRAM_ENTITY_NOT_RESOLVABLE");
    const latest = await telegramEntities.latestSnapshot(123456789n);
    expect(latest).toMatchObject({
      username: "starhashrobot",
      entityKind: "bot",
      displayName: "Star Hash",
    });
  });

  it("resolves an observed user handle by cached numeric ID when cold @handle lookup fails", async () => {
    const telegramEntities = createInMemoryTelegramEntityStore();
    await telegramEntities.recordSnapshot({
      entityId: 424242n,
      entityKind: "user",
      observedAt: new Date("2026-05-19T10:00:00Z"),
      username: "latifkasuli",
      activeUsernames: null,
      displayName: "Latif Kasuli",
      bio: null,
      photoFileUniqueId: null,
      isPremium: null,
      memberCount: null,
      isBot: false,
      source: "message_observe",
      raw: null,
    });
    const getChat = vi.fn((target: string) => {
      if (target === "@latifkasuli") {
        return Promise.reject(
          Object.assign(new Error("Bad Request: chat not found"), {
            error_code: 400,
            description: "Bad Request: chat not found",
          }),
        );
      }
      if (target === "424242") {
        return Promise.resolve({
          id: 424242,
          type: "private",
          username: "latifkasuli",
          first_name: "Latif",
          last_name: "Kasuli",
          is_bot: false,
        });
      }
      return Promise.reject(new Error(`unexpected getChat target ${target}`));
    });
    const telegramIntel: TelegramIntelClient = {
      enabled: true,
      apiBaseUrl: "https://api.telegram.org",
      raw: { getChat } as unknown as TelegramIntelClient["raw"],
    };

    const report = await createBasicScan({
      rawInput: "@latifkasuli",
      telegramIntel,
      telegramEntities,
    });

    expect(getChat).toHaveBeenNthCalledWith(1, "@latifkasuli");
    expect(getChat).toHaveBeenNthCalledWith(2, "424242");
    expect(report.findings.map((f) => f.ruleId)).not.toContain("TELEGRAM_ENTITY_NOT_RESOLVABLE");
    const latest = await telegramEntities.latestSnapshot(424242n);
    expect(latest).toMatchObject({
      username: "latifkasuli",
      entityKind: "user",
      source: "getChat",
      displayName: "Latif Kasuli",
    });
  });

  it("falls back to MTProto for cold public user handles when Bot API cannot resolve them", async () => {
    const getChat = vi.fn().mockRejectedValue(
      Object.assign(new Error("Bad Request: chat not found"), {
        error_code: 400,
        description: "Bad Request: chat not found",
      }),
    );
    const telegramIntel: TelegramIntelClient = {
      enabled: true,
      apiBaseUrl: "https://api.telegram.org",
      raw: { getChat } as unknown as TelegramIntelClient["raw"],
    };
    const resolveUsername = vi.fn().mockResolvedValue({
      status: "ok",
      entity: {
        id: 424242n,
        kind: "user",
        username: "latifkasuli",
        activeUsernames: null,
        displayName: "Latif Kasuli",
        bio: null,
        photoFileUniqueId: null,
        isPremium: null,
        memberCount: null,
        isBot: false,
        raw: {},
      },
    });
    const mtprotoIntel: MtprotoIntelClient = {
      enabled: true,
      authMode: "bot",
      resolveUsername,
      close: vi.fn(),
    };
    const telegramEntities = createInMemoryTelegramEntityStore();

    const report = await createBasicScan({
      rawInput: "@latifkasuli",
      telegramIntel,
      mtprotoIntel,
      telegramEntities,
    });

    expect(getChat).toHaveBeenCalledWith("@latifkasuli");
    expect(resolveUsername).toHaveBeenCalledWith("@latifkasuli");
    expect(report.findings.map((f) => f.ruleId)).not.toContain("TELEGRAM_ENTITY_NOT_RESOLVABLE");
    const latest = await telegramEntities.latestSnapshot(424242n);
    expect(latest).toMatchObject({
      username: "latifkasuli",
      entityKind: "user",
      source: "mtproto",
    });
  });

  it("uses MTProto for public handles even when Bot API intel is disabled", async () => {
    const resolveUsername = vi.fn().mockResolvedValue({
      status: "ok",
      entity: {
        id: 777777n,
        kind: "bot",
        username: "somewalletbot",
        activeUsernames: null,
        displayName: "Some Wallet",
        bio: null,
        photoFileUniqueId: null,
        isPremium: null,
        memberCount: null,
        isBot: true,
        raw: {},
      },
    });
    const mtprotoIntel: MtprotoIntelClient = {
      enabled: true,
      authMode: "bot",
      resolveUsername,
      close: vi.fn(),
    };

    const report = await createBasicScan({
      rawInput: "@somewalletbot",
      mtprotoIntel,
      telegramEntities: createInMemoryTelegramEntityStore(),
    });

    expect(resolveUsername).toHaveBeenCalledWith("@somewalletbot");
    expect(report.findings.map((f) => f.ruleId)).not.toContain("TELEGRAM_BOT_API_NOT_CONFIGURED");
    expect(report.findings.map((f) => f.ruleId)).not.toContain("TELEGRAM_ENTITY_NOT_RESOLVABLE");
  });

  it("flags an exact official handle when the project itself is locally risk-listed", async () => {
    const getChat = vi.fn().mockResolvedValue({
      id: 987654321,
      type: "private",
      username: "starshash_bot",
      first_name: "StarsHash",
      is_bot: true,
    });
    const telegramIntel: TelegramIntelClient = {
      enabled: true,
      apiBaseUrl: "https://api.telegram.org",
      raw: { getChat } as unknown as TelegramIntelClient["raw"],
    };

    const report = await createBasicScan({
      rawInput: "@starshash_bot",
      telegramIntel,
      telegramEntities: createInMemoryTelegramEntityStore(),
    });

    expect(report.findings.map((f) => f.ruleId)).toContain("TELEGRAM_KNOWN_RISK_PROJECT");
    expect(report.findings.map((f) => f.ruleId)).not.toContain(
      "TELEGRAM_HANDLE_IMPERSONATES_PROJECT",
    );
    expect(
      report.findings.find((f) => f.ruleId === "TELEGRAM_KNOWN_RISK_PROJECT")?.evidence,
    ).toMatchObject({
      project: "StarsHash",
      risk: "operator_reported_funds_misconduct",
    });
  });

  it("emits TELEGRAM_INPUT_RECOGNISED_NOT_SCANNED for t.me URLs with no resolvable handle (joinchat, +invite, /c/...)", async () => {
    // PR-2 review High #2: t.me/+abcdef and t.me/c/<id>/N landed as
    // telegram_url with handle:null and gatherScanResult dropped them.
    const cases = [
      "https://t.me/joinchat/AAAAAAAA",
      "https://t.me/+abcdefghij",
      "https://t.me/c/1234567890/42",
    ];

    for (const rawInput of cases) {
      const report = await createBasicScan({
        rawInput,
        telegramEntities: createInMemoryTelegramEntityStore(),
      });

      const finding = report.findings.find(
        (f) => f.ruleId === "TELEGRAM_INPUT_RECOGNISED_NOT_SCANNED",
      );
      expect(finding, `for input ${rawInput}`).toBeDefined();
      expect(finding?.evidence).toMatchObject({
        reason: "no_resolvable_handle_in_url",
      });
    }
  });

  it("emits TELEGRAM_INPUT_RECOGNISED_NOT_SCANNED when the snapshot store isn't wired (caller misconfiguration)", async () => {
    // PR-2 review High #3: missing telegramEntities returned empty
    // findings silently. Now we surface a finding with reason=
    // snapshot_store_not_wired so the misconfiguration is visible.
    const report = await createBasicScan({
      rawInput: "@somebot",
      // No telegramEntities passed — simulates caller error.
    });

    const finding = report.findings.find(
      (f) => f.ruleId === "TELEGRAM_INPUT_RECOGNISED_NOT_SCANNED",
    );
    expect(finding).toBeDefined();
    expect(finding?.evidence).toMatchObject({
      reason: "snapshot_store_not_wired",
    });
  });
});
