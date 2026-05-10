import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  emulateMessageToWallet,
  fetchSenderMetadata,
  buildExternalMessageBoc,
  type EmulationResult,
  type SenderMetadataResult,
  type TonEmulatorClient,
} from "@tonshield/ton-emulator";
import type { TransactionJsonInput } from "@tonshield/shared";
import { scanTransactionWithEmulation } from "../src/transaction/emulation-scanner.ts";

// Mock the three boundary functions from `@tonshield/ton-emulator` we depend
// on. The scanner under test should orchestrate them; their internals are
// covered by their own packages' tests.
vi.mock("@tonshield/ton-emulator", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tonshield/ton-emulator")>();

  return {
    ...original,
    emulateMessageToWallet: vi.fn(),
    fetchSenderMetadata: vi.fn(),
    buildExternalMessageBoc: vi.fn(),
  };
});

const mockedEmulate = vi.mocked(emulateMessageToWallet);
const mockedFetchMetadata = vi.mocked(fetchSenderMetadata);
const mockedBuildBoc = vi.mocked(buildExternalMessageBoc);

const SENDER_FRIENDLY = "UQAQxxpzxmEVU0Lu8U0zNTxBzXIWPvo263TIN1OQM9YvxsnV";
const RECIPIENT_FRIENDLY = "UQDNzlh0XSZdb5_Qrlx5QjyZHVAO74v5oMeVVrtF_5Vt1rIt";
// Raw form of RECIPIENT_FRIENDLY. Used in default emulation action fixtures
// so the diff module pairs the static and emulated side cleanly when tests
// don't override.
const RECIPIENT_RAW = "0:cdce58745d265d6f9fd0ae5c79423c991d500eef8bf9a0c79556bb45ff956dd6";

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

const buildInput = (
  transaction: Readonly<Record<string, unknown>> = {
    from: SENDER_FRIENDLY,
    messages: [{ address: RECIPIENT_FRIENDLY, amount: "1000000" }],
  },
): TransactionJsonInput => ({
  kind: "transaction_json",
  raw: JSON.stringify(transaction),
  normalized: JSON.stringify(transaction),
  transaction,
});

const okMetadata = (): Extract<SenderMetadataResult, { status: "ok" }> => ({
  status: "ok",
  metadata: {
    walletVersion: "v4r2",
    publicKey: Buffer.alloc(32, 0x01),
    seqno: 5,
    networkGlobalId: -239,
    exists: true,
  },
});

const okEmulationResult = (
  overrides: Partial<Extract<EmulationResult, { status: "ok" }>> = {},
): Extract<EmulationResult, { status: "ok" }> => ({
  status: "ok",
  actions: [
    {
      kind: "ton_transfer",
      status: "ok",
      simplePreview: "Transferring 1 TON",
      rawType: "TonTransfer",
      // Pair with baseStaticContext's lone TON send (10 nanoton to RECIPIENT)
      // so the diff module produces no mismatches by default. Tests that
      // care about the diff override this to introduce intentional defects.
      details: { kind: "ton_transfer", recipient: RECIPIENT_RAW, amountNano: 10n },
    },
  ],
  risk: {
    transferAllRemainingBalance: false,
    tonNano: 1_000_000n,
    jettons: [],
    nfts: [],
    totalEquivalentUsd: null,
  },
  trace: { aborted: false, isScam: false },
  ...overrides,
});

const ruleIds = (findings: readonly { ruleId: string }[]): readonly string[] =>
  findings.map((f) => f.ruleId);

// One static TON send to the recipient at 10 nanoton — paired by position
// with the okEmulationResult()'s single TonTransfer for the OK-path tests.
// Tests that exercise the diff module override this with richer fixtures.
const baseStaticContext = {
  staticMessages: [
    {
      to: RECIPIENT_FRIENDLY,
      value: 10n,
      bounce: false,
      payload: { kind: "none" as const },
      hasStateInit: false,
    },
  ],
  staticHasStateInit: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedBuildBoc.mockResolvedValue("dummy-boc-base64");
});

// ── degradation paths required by PR-C ─────────────────────────────────────

describe("scanTransactionWithEmulation degradation paths", () => {
  it("emits EMULATION_NOT_CONFIGURED when no emulator client is provided", async () => {
    const result = await scanTransactionWithEmulation(undefined, buildInput(), baseStaticContext);

    expect(ruleIds(result.findings)).toEqual(["EMULATION_NOT_CONFIGURED"]);
    expect(result.actions).toEqual([]);
    expect(mockedFetchMetadata).not.toHaveBeenCalled();
  });

  it("emits EMULATION_NOT_CONFIGURED when the client is disabled", async () => {
    const result = await scanTransactionWithEmulation(
      disabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toEqual(["EMULATION_NOT_CONFIGURED"]);
    expect(mockedFetchMetadata).not.toHaveBeenCalled();
  });

  it("emits EMULATION_SKIPPED_NO_SENDER when transaction has no `from` field", async () => {
    const input = buildInput({
      messages: [{ address: RECIPIENT_FRIENDLY, amount: "1000000" }],
      // no `from`
    });

    const result = await scanTransactionWithEmulation(enabledClient, input, baseStaticContext);

    expect(ruleIds(result.findings)).toEqual(["EMULATION_SKIPPED_NO_SENDER"]);
    expect(mockedFetchMetadata).not.toHaveBeenCalled();
  });

  it("emits EMULATION_SKIPPED_NO_SENDER when `from` is unparseable", async () => {
    const input = buildInput({ from: "not-an-address", messages: [] });

    const result = await scanTransactionWithEmulation(enabledClient, input, baseStaticContext);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe("EMULATION_SKIPPED_NO_SENDER");
    expect(result.findings[0]?.evidence).toMatchObject({ reason: "from_unparseable" });
  });

  it("emits EMULATION_SENDER_UNINITIALISED when sender exists but is uninit", async () => {
    mockedFetchMetadata.mockResolvedValue({ status: "uninitialised" });

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toEqual(["EMULATION_SENDER_UNINITIALISED"]);
    expect(mockedEmulate).not.toHaveBeenCalled();
  });

  it("silently skips when sender is a non-wallet contract (PR-D handles trace fallback)", async () => {
    mockedFetchMetadata.mockResolvedValue({
      status: "unknown_wallet",
      interfaces: ["multisig"],
    });

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(result.findings).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(mockedEmulate).not.toHaveBeenCalled();
  });

  it("classifies metadata-fetch 5xx as EMULATION_PROVIDER_DOWN and skips the emulate call", async () => {
    mockedFetchMetadata.mockResolvedValue({ status: "fetch_failed", httpStatus: 503 });

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toEqual(["EMULATION_PROVIDER_DOWN"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      source: "metadata_fetch",
      httpStatus: 503,
    });
    expect(mockedEmulate).not.toHaveBeenCalled();
  });

  it("classifies metadata-fetch 429 as EMULATION_RATE_LIMITED", async () => {
    mockedFetchMetadata.mockResolvedValue({ status: "fetch_failed", httpStatus: 429 });

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toEqual(["EMULATION_RATE_LIMITED"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      source: "metadata_fetch",
      httpStatus: 429,
    });
  });

  it("classifies metadata-fetch 4xx (non-429) as EMULATION_FAILED", async () => {
    mockedFetchMetadata.mockResolvedValue({ status: "fetch_failed", httpStatus: 401 });

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toEqual(["EMULATION_FAILED"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      source: "metadata_fetch",
      httpStatus: 401,
    });
  });

  it("classifies metadata-fetch network/timeout (httpStatus null) as EMULATION_PROVIDER_DOWN", async () => {
    mockedFetchMetadata.mockResolvedValue({ status: "fetch_failed", httpStatus: null });

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toEqual(["EMULATION_PROVIDER_DOWN"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      source: "metadata_fetch",
      httpStatus: null,
    });
  });

  it("emits TRANSACTION_MALFORMED_MESSAGE when the request builder throws", async () => {
    mockedFetchMetadata.mockResolvedValue(okMetadata());
    mockedBuildBoc.mockRejectedValue(
      new Error("amount must be an unsigned decimal integer string"),
    );

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toEqual(["TRANSACTION_MALFORMED_MESSAGE"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      source: "emulation_request_builder",
    });
    // Reason carries the original error message — assert it separately so the
    // matcher's `any` typing doesn't leak into the toMatchObject argument.
    expect(String(result.findings[0]?.evidence.reason)).toContain(
      "unsigned decimal integer string",
    );
    expect(mockedEmulate).not.toHaveBeenCalled();
  });

  // ── all-or-nothing structural validation of `messages[]` ─────────────────
  //
  // TON Connect `messages` is semantically ordered. Emulating only the
  // well-formed subset would produce a misleading risk report, so any
  // structural defect rejects the whole request as TRANSACTION_MALFORMED_MESSAGE.

  it.each([
    [
      "messages is not an array",
      { from: SENDER_FRIENDLY, messages: "not-an-array" },
      /not an array/,
    ],
    [
      "messages array is empty",
      { from: SENDER_FRIENDLY, messages: [] },
      /requires at least one message/,
    ],
    [
      "entry is not an object",
      { from: SENDER_FRIENDLY, messages: ["not-an-object"] },
      /not an object/,
    ],
    [
      "entry missing address",
      { from: SENDER_FRIENDLY, messages: [{ amount: "100" }] },
      /missing required string `address`/,
    ],
    [
      "entry missing amount",
      { from: SENDER_FRIENDLY, messages: [{ address: RECIPIENT_FRIENDLY }] },
      /missing required string `amount`/,
    ],
    [
      "entry has non-string address",
      { from: SENDER_FRIENDLY, messages: [{ address: 123, amount: "100" }] },
      /missing required string `address`/,
    ],
    [
      "entry has non-string amount",
      { from: SENDER_FRIENDLY, messages: [{ address: RECIPIENT_FRIENDLY, amount: 100 }] },
      /missing required string `amount`/,
    ],
    [
      "extraCurrency is not a string→string map",
      {
        from: SENDER_FRIENDLY,
        messages: [{ address: RECIPIENT_FRIENDLY, amount: "100", extraCurrency: { 100: 1000 } }],
      },
      /string.string map/,
    ],
  ])("rejects whole request when %s", async (_label, transaction, expectedReason) => {
    mockedFetchMetadata.mockResolvedValue(okMetadata());

    const input: TransactionJsonInput = {
      kind: "transaction_json",
      raw: JSON.stringify(transaction),
      normalized: JSON.stringify(transaction),
      transaction,
    };

    const result = await scanTransactionWithEmulation(enabledClient, input, baseStaticContext);

    expect(ruleIds(result.findings)).toEqual(["TRANSACTION_MALFORMED_MESSAGE"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      source: "emulation_scanner_parser",
    });
    expect(String(result.findings[0]?.evidence.reason)).toMatch(expectedReason);
    // Critically: emulation MUST NOT run on a partial / silently-truncated
    // message list. Verify the request builder is never called.
    expect(mockedBuildBoc).not.toHaveBeenCalled();
    expect(mockedEmulate).not.toHaveBeenCalled();
  });

  it("emits EMULATION_SKIPPED_NO_MESSAGES (not MALFORMED) when messages field is absent", async () => {
    // M1.5 backwards-compat regression test: the static decoder accepts
    // single-message format (no `messages[]`, just top-level fields), so
    // emitting MALFORMED here would falsely contradict the static decode.
    // Skip emulation gracefully instead.
    mockedFetchMetadata.mockResolvedValue(okMetadata());
    const transaction = {
      from: SENDER_FRIENDLY,
      // single-message format: top-level address/amount, no messages[]
      address: RECIPIENT_FRIENDLY,
      amount: "100",
    };
    const input: TransactionJsonInput = {
      kind: "transaction_json",
      raw: JSON.stringify(transaction),
      normalized: JSON.stringify(transaction),
      transaction,
    };

    const result = await scanTransactionWithEmulation(enabledClient, input, baseStaticContext);

    expect(ruleIds(result.findings)).toEqual(["EMULATION_SKIPPED_NO_MESSAGES"]);
    expect(ruleIds(result.findings)).not.toContain("TRANSACTION_MALFORMED_MESSAGE");
    expect(mockedBuildBoc).not.toHaveBeenCalled();
    expect(mockedEmulate).not.toHaveBeenCalled();
  });

  it("emits TRANSACTION_MALFORMED_MESSAGE with the bad entry's index in evidence", async () => {
    mockedFetchMetadata.mockResolvedValue(okMetadata());

    const transaction = {
      from: SENDER_FRIENDLY,
      messages: [
        { address: RECIPIENT_FRIENDLY, amount: "100" },
        { address: RECIPIENT_FRIENDLY }, // missing amount
        { address: RECIPIENT_FRIENDLY, amount: "200" },
      ],
    };
    const input: TransactionJsonInput = {
      kind: "transaction_json",
      raw: JSON.stringify(transaction),
      normalized: JSON.stringify(transaction),
      transaction,
    };

    const result = await scanTransactionWithEmulation(enabledClient, input, baseStaticContext);

    expect(result.findings[0]?.evidence).toMatchObject({ index: 1 });
  });

  it("classifies emulate-call 429 as EMULATION_RATE_LIMITED with reason in evidence", async () => {
    mockedFetchMetadata.mockResolvedValue(okMetadata());
    mockedEmulate.mockResolvedValue({ status: "failed", reason: "rate_limited", httpStatus: 429 });

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toEqual(["EMULATION_RATE_LIMITED"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      source: "emulate_call",
      reason: "rate_limited",
      httpStatus: 429,
    });
    expect(result.actions).toEqual([]);
  });

  it("classifies emulate-call 5xx as EMULATION_PROVIDER_DOWN", async () => {
    mockedFetchMetadata.mockResolvedValue(okMetadata());
    mockedEmulate.mockResolvedValue({
      status: "failed",
      reason: "provider_down",
      httpStatus: 502,
    });

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toEqual(["EMULATION_PROVIDER_DOWN"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      source: "emulate_call",
      reason: "provider_down",
      httpStatus: 502,
    });
  });

  it("classifies emulate-call network/timeout (httpStatus null) as EMULATION_PROVIDER_DOWN", async () => {
    mockedFetchMetadata.mockResolvedValue(okMetadata());
    mockedEmulate.mockResolvedValue({
      status: "failed",
      reason: "provider_down",
      httpStatus: null,
    });

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toEqual(["EMULATION_PROVIDER_DOWN"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      source: "emulate_call",
      reason: "provider_down",
      httpStatus: null,
    });
  });

  it("classifies emulate-call bad_request (non-429 4xx) as EMULATION_FAILED", async () => {
    mockedFetchMetadata.mockResolvedValue(okMetadata());
    mockedEmulate.mockResolvedValue({
      status: "failed",
      reason: "bad_request",
      httpStatus: 422,
    });

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toEqual(["EMULATION_FAILED"]);
    expect(result.findings[0]?.evidence).toMatchObject({
      source: "emulate_call",
      reason: "bad_request",
      httpStatus: 422,
    });
  });
});

// ── successful response → findings + actions ────────────────────────────────

describe("scanTransactionWithEmulation OK responses", () => {
  beforeEach(() => {
    mockedFetchMetadata.mockResolvedValue(okMetadata());
  });

  it("converts a clean TON transfer into an action and no findings", async () => {
    mockedEmulate.mockResolvedValue(okEmulationResult());

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(result.findings).toEqual([]);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.kind).toBe("send_ton");
    expect(result.actions[0]?.title).toContain("emulated");
    expect(result.actions[0]?.description).toBe("Transferring 1 TON");
  });

  it("emits EMULATION_SENDS_NEAR_FULL_BALANCE when risk.transfer_all_remaining_balance is true", async () => {
    mockedEmulate.mockResolvedValue(
      okEmulationResult({
        risk: {
          transferAllRemainingBalance: true,
          tonNano: 9_999_999_999n,
          jettons: [],
          nfts: [],
          totalEquivalentUsd: null,
        },
      }),
    );

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toContain("EMULATION_SENDS_NEAR_FULL_BALANCE");
    expect(
      result.findings.find((f) => f.ruleId === "EMULATION_SENDS_NEAR_FULL_BALANCE")?.evidence,
    ).toMatchObject({ tonNano: "9999999999" });
  });

  it("emits EMULATION_WALLET_V5_AUTH_CHANGE for AddExtension", async () => {
    mockedEmulate.mockResolvedValue(
      okEmulationResult({
        actions: [
          {
            kind: "add_extension",
            status: "ok",
            simplePreview: "Add extension",
            rawType: "AddExtension",
            details: null,
          },
        ],
      }),
    );

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toContain("EMULATION_WALLET_V5_AUTH_CHANGE");
    expect(result.actions[0]?.kind).toBe("change_wallet_permission");
  });

  it("emits EMULATION_WALLET_V5_AUTH_CHANGE for SetSignatureAllowedAction", async () => {
    mockedEmulate.mockResolvedValue(
      okEmulationResult({
        actions: [
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

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toContain("EMULATION_WALLET_V5_AUTH_CHANGE");
  });

  it("emits EMULATION_ABORTED when the trace's root transaction aborted", async () => {
    mockedEmulate.mockResolvedValue(okEmulationResult({ trace: { aborted: true, isScam: false } }));

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toContain("EMULATION_ABORTED");
  });

  it("emits EMULATION_SCAM_PATTERN_DETECTED when event.is_scam is true", async () => {
    mockedEmulate.mockResolvedValue(okEmulationResult({ trace: { aborted: false, isScam: true } }));

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toContain("EMULATION_SCAM_PATTERN_DETECTED");
  });

  // ── PR-D2 structured diff: scanner-level integration ────────────────────
  //
  // The diff logic itself is covered exhaustively in diff.test.ts. These
  // tests pin only the integration: the scanner correctly threads
  // staticContext.staticMessages through and maps DiffMismatch / DiffHiddenAction
  // entries to the right findings with the right evidence shape.

  it("emits EMULATION_REVEALED_HIDDEN_ACTION when emulator produces an extra TonTransfer with no static counterpart", async () => {
    mockedEmulate.mockResolvedValue(
      okEmulationResult({
        actions: [
          {
            kind: "ton_transfer",
            status: "ok",
            simplePreview: "Send 1 TON",
            rawType: "TonTransfer",
            details: { kind: "ton_transfer", recipient: RECIPIENT_RAW, amountNano: 10n },
          },
          {
            kind: "jetton_transfer",
            status: "ok",
            simplePreview: "Jetton notification (not flagged — out of D2 scope)",
            rawType: "JettonTransfer",
            details: null,
          },
          {
            kind: "ton_transfer",
            status: "ok",
            simplePreview: "Hidden second TON transfer",
            rawType: "TonTransfer",
            details: {
              kind: "ton_transfer",
              recipient: "0:abcdef0000000000000000000000000000000000000000000000000000000000",
              amountNano: 50_000_000n,
            },
          },
        ],
      }),
    );

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toContain("EMULATION_REVEALED_HIDDEN_ACTION");
    expect(
      result.findings.find((f) => f.ruleId === "EMULATION_REVEALED_HIDDEN_ACTION")?.evidence,
    ).toMatchObject({
      kind: "ton_transfer",
      rawType: "TonTransfer",
      emulatedActionIndex: 2,
      recipient: "0:abcdef0000000000000000000000000000000000000000000000000000000000",
      amountNano: "50000000",
    });
  });

  it("does NOT emit hidden-action finding when every emulated TonTransfer has a static counterpart", async () => {
    mockedEmulate.mockResolvedValue(okEmulationResult());

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).not.toContain("EMULATION_REVEALED_HIDDEN_ACTION");
  });

  it("emits EMULATION_MISMATCH with destination evidence when emulated recipient differs", async () => {
    mockedEmulate.mockResolvedValue(
      okEmulationResult({
        actions: [
          {
            kind: "ton_transfer",
            status: "ok",
            simplePreview: "Send 1 TON to attacker",
            rawType: "TonTransfer",
            details: {
              kind: "ton_transfer",
              recipient: "0:abcdef0000000000000000000000000000000000000000000000000000000000",
              amountNano: 10n,
            },
          },
        ],
      }),
    );

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(ruleIds(result.findings)).toContain("EMULATION_MISMATCH");
    expect(result.findings.find((f) => f.ruleId === "EMULATION_MISMATCH")?.evidence).toMatchObject({
      field: "destination",
      messageIndex: 0,
      staticDestination: RECIPIENT_FRIENDLY,
      emulatedDestination: "0:abcdef0000000000000000000000000000000000000000000000000000000000",
    });
  });

  it("emits EMULATION_MISMATCH with amount evidence when emulated amount differs but destination matches", async () => {
    mockedEmulate.mockResolvedValue(
      okEmulationResult({
        actions: [
          {
            kind: "ton_transfer",
            status: "ok",
            simplePreview: "Send way more than declared",
            rawType: "TonTransfer",
            details: { kind: "ton_transfer", recipient: RECIPIENT_RAW, amountNano: 999_999_999n },
          },
        ],
      }),
    );

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    const mismatch = result.findings.find((f) => f.ruleId === "EMULATION_MISMATCH");
    expect(mismatch?.evidence).toMatchObject({
      field: "amount",
      messageIndex: 0,
      destination: RECIPIENT_RAW,
      staticAmountNano: "10",
      emulatedAmountNano: "999999999",
    });
  });

  it("emits EMULATION_DEPLOYS_UNKNOWN_CONTRACT when emulator deploys but no static stateInit", async () => {
    mockedEmulate.mockResolvedValue(
      okEmulationResult({
        actions: [
          {
            kind: "contract_deploy",
            status: "ok",
            simplePreview: "Deploy",
            rawType: "ContractDeploy",
            details: {
              kind: "contract_deploy",
              address: "0:abcdef0000000000000000000000000000000000000000000000000000000000",
              interfaces: ["nft_item"],
            },
          },
        ],
      }),
    );

    const result = await scanTransactionWithEmulation(enabledClient, buildInput(), {
      ...baseStaticContext,
      staticHasStateInit: false,
    });

    expect(ruleIds(result.findings)).toContain("EMULATION_DEPLOYS_UNKNOWN_CONTRACT");
  });

  it("does NOT emit deploy finding when the static decode also has stateInit", async () => {
    mockedEmulate.mockResolvedValue(
      okEmulationResult({
        actions: [
          {
            kind: "contract_deploy",
            status: "ok",
            simplePreview: "Deploy",
            rawType: "ContractDeploy",
            details: {
              kind: "contract_deploy",
              address: "0:abcdef0000000000000000000000000000000000000000000000000000000000",
              interfaces: ["nft_item"],
            },
          },
        ],
      }),
    );

    const result = await scanTransactionWithEmulation(enabledClient, buildInput(), {
      ...baseStaticContext,
      staticHasStateInit: true,
    });

    expect(ruleIds(result.findings)).not.toContain("EMULATION_DEPLOYS_UNKNOWN_CONTRACT");
  });

  it("preserves TONAPI's simple_preview as the action description", async () => {
    mockedEmulate.mockResolvedValue(
      okEmulationResult({
        actions: [
          {
            kind: "jetton_transfer",
            status: "ok",
            simplePreview: "Transferring 250 USDT to EQAB...",
            rawType: "JettonTransfer",
            details: null,
          },
        ],
      }),
    );

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(result.actions[0]?.description).toBe("Transferring 250 USDT to EQAB...");
  });

  it("collapses jetton/nft action variants onto the right ActionPreview kinds", async () => {
    mockedEmulate.mockResolvedValue(
      okEmulationResult({
        actions: [
          {
            kind: "jetton_burn",
            status: "ok",
            simplePreview: "Burn",
            rawType: "JettonBurn",
            details: null,
          },
          {
            kind: "nft_purchase",
            status: "ok",
            simplePreview: "Buy",
            rawType: "NftPurchase",
            details: null,
          },
          {
            kind: "domain_renew",
            status: "ok",
            simplePreview: "Renew",
            rawType: "DomainRenew",
            details: null,
          },
        ],
      }),
    );

    const result = await scanTransactionWithEmulation(
      enabledClient,
      buildInput(),
      baseStaticContext,
    );

    expect(result.actions.map((a) => a.kind)).toEqual(["send_jetton", "send_nft", "unknown"]);
  });
});
