import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emulateMessageToEvent,
  type EventsEmulateOk,
  type TonEmulatorClient,
} from "@tonshield/ton-emulator";
import type { BocInput } from "@tonshield/shared";
import { scanBocWithEmulation } from "../src/boc/scanner.ts";

// Boundary-mock the events-emulate wrapper. Its own contract is covered in
// the emulator package's emulate.test.ts; these tests focus on the
// scanner's emission rules — what findings fire on which response shapes,
// and what's intentionally suppressed on the BOC path.
vi.mock("@tonshield/ton-emulator", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tonshield/ton-emulator")>();

  return {
    ...original,
    emulateMessageToEvent: vi.fn(),
  };
});

const mockedEmulate = vi.mocked(emulateMessageToEvent);

const enabledClient: TonEmulatorClient = {
  enabled: true,
  baseUrl: "https://tonapi.io",
  raw: {} as TonEmulatorClient["raw"],
};
const disabledClient: TonEmulatorClient = {
  enabled: false,
  baseUrl: "https://tonapi.io",
  raw: {} as TonEmulatorClient["raw"],
};

const bocInput = (boc = "te6cckEBAQEAAgAAAEysuc0="): BocInput => ({
  kind: "boc",
  raw: boc,
  normalized: boc,
  boc,
});

const okEventsResult = (overrides: Partial<EventsEmulateOk> = {}): EventsEmulateOk => ({
  status: "ok",
  source: "events_emulate",
  actions: [],
  risk: null,
  trace: { aborted: null, isScam: false },
  ...overrides,
});

const ruleIds = (findings: readonly { ruleId: string }[]): readonly string[] =>
  findings.map((f) => f.ruleId);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── degradation paths ───────────────────────────────────────────────────────

describe("scanBocWithEmulation degradation paths", () => {
  it("emits EMULATION_NOT_CONFIGURED when no emulator client is provided", async () => {
    const result = await scanBocWithEmulation(undefined, bocInput());

    expect(ruleIds(result.findings)).toEqual(["EMULATION_NOT_CONFIGURED"]);
    expect(result.actions).toEqual([]);
    expect(mockedEmulate).not.toHaveBeenCalled();
  });

  it("emits EMULATION_NOT_CONFIGURED when the client is disabled", async () => {
    const result = await scanBocWithEmulation(disabledClient, bocInput());

    expect(ruleIds(result.findings)).toEqual(["EMULATION_NOT_CONFIGURED"]);
    expect(mockedEmulate).not.toHaveBeenCalled();
  });

  it("emits TRANSACTION_MALFORMED_MESSAGE when Cell.fromBase64 throws on an unparseable BOC", async () => {
    // The wrapper throws synchronously for invalid base64 — we surface
    // that as the M1.5 malformed-message rule with parse error in evidence,
    // rather than inventing a new rule for what is structurally the same
    // defect: bytes the system can't decode.
    mockedEmulate.mockRejectedValue(new Error("invalid base64"));

    const result = await scanBocWithEmulation(enabledClient, bocInput("not-base64"));

    expect(ruleIds(result.findings)).toEqual(["TRANSACTION_MALFORMED_MESSAGE"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      source: "boc_parse",
    });
    expect(String(result.findings[0]?.evidence.reason)).toContain("invalid base64");
  });

  it("classifies 429 from events-emulate as EMULATION_RATE_LIMITED", async () => {
    mockedEmulate.mockResolvedValue({
      status: "failed",
      reason: "rate_limited",
      httpStatus: 429,
    });

    const result = await scanBocWithEmulation(enabledClient, bocInput());

    expect(ruleIds(result.findings)).toEqual(["EMULATION_RATE_LIMITED"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      source: "events_emulate_call",
      reason: "rate_limited",
      httpStatus: 429,
    });
  });

  it("classifies 5xx as EMULATION_PROVIDER_DOWN", async () => {
    mockedEmulate.mockResolvedValue({
      status: "failed",
      reason: "provider_down",
      httpStatus: 503,
    });

    const result = await scanBocWithEmulation(enabledClient, bocInput());

    expect(ruleIds(result.findings)).toEqual(["EMULATION_PROVIDER_DOWN"]);
  });

  it("classifies non-429 4xx as EMULATION_FAILED", async () => {
    mockedEmulate.mockResolvedValue({
      status: "failed",
      reason: "bad_request",
      httpStatus: 422,
    });

    const result = await scanBocWithEmulation(enabledClient, bocInput());

    expect(ruleIds(result.findings)).toEqual(["EMULATION_FAILED"]);
  });
});

// ── OK responses: emission discipline ───────────────────────────────────────
//
// The BOC path has tighter emission rules than the transaction path because
// there's no static side, no risk object, and no trace. These tests pin
// what IS allowed to fire and what is NOT.

describe("scanBocWithEmulation OK responses", () => {
  it("returns action previews and no findings on a clean BOC scan", async () => {
    mockedEmulate.mockResolvedValue(
      okEventsResult({
        actions: [
          {
            kind: "ton_transfer",
            status: "ok",
            simplePreview: "Send 0.01 TON",
            rawType: "TonTransfer",
            details: {
              kind: "ton_transfer",
              recipient: "0:cdce58745d265d6f9fd0ae5c79423c991d500eef8bf9a0c79556bb45ff956dd6",
              amountNano: 10_000_000n,
            },
          },
        ],
      }),
    );

    const result = await scanBocWithEmulation(enabledClient, bocInput());

    expect(result.findings).toEqual([]);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.kind).toBe("send_ton");
    expect(result.actions[0]?.title).toContain("emulated");
  });

  it("emits EMULATION_SCAM_PATTERN_DETECTED when is_scam is true", async () => {
    mockedEmulate.mockResolvedValue(okEventsResult({ trace: { aborted: null, isScam: true } }));

    const result = await scanBocWithEmulation(enabledClient, bocInput());

    expect(ruleIds(result.findings)).toContain("EMULATION_SCAM_PATTERN_DETECTED");
    expect(
      result.findings.find((f) => f.ruleId === "EMULATION_SCAM_PATTERN_DETECTED")?.evidence,
    ).toMatchObject({ source: "events_emulate" });
  });

  it("emits EMULATION_WALLET_V5_AUTH_CHANGE for AddExtension action", async () => {
    mockedEmulate.mockResolvedValue(
      okEventsResult({
        actions: [
          {
            kind: "add_extension",
            status: "ok",
            simplePreview: "Add extension EQ...",
            rawType: "AddExtension",
            details: null,
          },
        ],
      }),
    );

    const result = await scanBocWithEmulation(enabledClient, bocInput());

    expect(ruleIds(result.findings)).toContain("EMULATION_WALLET_V5_AUTH_CHANGE");
    expect(
      result.findings.find((f) => f.ruleId === "EMULATION_WALLET_V5_AUTH_CHANGE")?.evidence,
    ).toMatchObject({
      kind: "add_extension",
      rawType: "AddExtension",
      source: "events_emulate",
    });
  });

  it("emits ONE EMULATION_WALLET_V5_AUTH_CHANGE per auth-changing action (not collapsed)", async () => {
    mockedEmulate.mockResolvedValue(
      okEventsResult({
        actions: [
          {
            kind: "add_extension",
            status: "ok",
            simplePreview: "Add A",
            rawType: "AddExtension",
            details: null,
          },
          {
            kind: "set_signature_allowed",
            status: "ok",
            simplePreview: "Disable signature auth",
            rawType: "SetSignatureAllowedAction",
            details: null,
          },
        ],
      }),
    );

    const result = await scanBocWithEmulation(enabledClient, bocInput());

    const authChangeFindings = result.findings.filter(
      (f) => f.ruleId === "EMULATION_WALLET_V5_AUTH_CHANGE",
    );
    expect(authChangeFindings).toHaveLength(2);
  });
});

// ── intentional suppressions: forbidden findings on the BOC path ────────────

describe("scanBocWithEmulation forbidden findings (PR-D3 emission discipline)", () => {
  it("does NOT emit EMULATION_MISMATCH (no static side to compare against)", async () => {
    // Even if the emulator returns a TonTransfer with concrete recipient
    // and amount, there's no static decode for a raw BOC, so the diff
    // module isn't called and `EMULATION_MISMATCH` cannot fire here.
    mockedEmulate.mockResolvedValue(
      okEventsResult({
        actions: [
          {
            kind: "ton_transfer",
            status: "ok",
            simplePreview: "Send 1 TON to attacker",
            rawType: "TonTransfer",
            details: {
              kind: "ton_transfer",
              recipient: "0:abcdef0000000000000000000000000000000000000000000000000000000000",
              amountNano: 1_000_000_000n,
            },
          },
        ],
      }),
    );

    const result = await scanBocWithEmulation(enabledClient, bocInput());

    expect(ruleIds(result.findings)).not.toContain("EMULATION_MISMATCH");
  });

  it("does NOT emit EMULATION_REVEALED_HIDDEN_ACTION (no static counterpart concept)", async () => {
    mockedEmulate.mockResolvedValue(
      okEventsResult({
        actions: [
          {
            kind: "ton_transfer",
            status: "ok",
            simplePreview: "1",
            rawType: "TonTransfer",
            details: {
              kind: "ton_transfer",
              recipient: "0:abcdef0000000000000000000000000000000000000000000000000000000000",
              amountNano: 1n,
            },
          },
          {
            kind: "ton_transfer",
            status: "ok",
            simplePreview: "2",
            rawType: "TonTransfer",
            details: {
              kind: "ton_transfer",
              recipient: "0:abcdef0000000000000000000000000000000000000000000000000000000000",
              amountNano: 2n,
            },
          },
        ],
      }),
    );

    const result = await scanBocWithEmulation(enabledClient, bocInput());

    expect(ruleIds(result.findings)).not.toContain("EMULATION_REVEALED_HIDDEN_ACTION");
  });

  it("does NOT emit EMULATION_SENDS_NEAR_FULL_BALANCE (no risk object from events-emulate)", async () => {
    // The events-emulate endpoint returns no risk object. The type system
    // already prevents this at compile time (risk is `null`), but pin it at
    // runtime too — a future change that loosens the type must not let
    // this finding silently start firing without a risk source.
    mockedEmulate.mockResolvedValue(okEventsResult());

    const result = await scanBocWithEmulation(enabledClient, bocInput());

    expect(ruleIds(result.findings)).not.toContain("EMULATION_SENDS_NEAR_FULL_BALANCE");
  });

  it("does NOT emit EMULATION_ABORTED (no trace.aborted from events-emulate)", async () => {
    // Same reasoning as the risk suppression. The events response has no
    // trace, so there's no honest source for the aborted flag.
    mockedEmulate.mockResolvedValue(okEventsResult());

    const result = await scanBocWithEmulation(enabledClient, bocInput());

    expect(ruleIds(result.findings)).not.toContain("EMULATION_ABORTED");
  });
});
