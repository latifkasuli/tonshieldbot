import { describe, expect, it, vi } from "vitest";
import * as emulator from "@tonshield/ton-emulator";
import type { TonEmulatorClient } from "@tonshield/ton-emulator";
import { createInMemoryTelegramEntityStore } from "@tonshield/storage";
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
  it("emits TELEGRAM_INPUT_RECOGNISED_NOT_SCANNED for t.me/nft/<slug> links", async () => {
    // PR-2 review High #1: nft_link fell through gatherScanResult and
    // produced no findings. Verdict was therefore "safe" — misleading.
    const report = await createBasicScan({
      rawInput: "https://t.me/nft/CrystalBall-42",
      telegramEntities: createInMemoryTelegramEntityStore(),
    });

    expect(report.findings.map((f) => f.ruleId)).toContain("TELEGRAM_INPUT_RECOGNISED_NOT_SCANNED");
    const finding = report.findings.find(
      (f) => f.ruleId === "TELEGRAM_INPUT_RECOGNISED_NOT_SCANNED",
    );
    expect(finding?.evidence).toMatchObject({
      inputKind: "telegram_nft_link",
      reason: "scanner_not_implemented_yet",
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
