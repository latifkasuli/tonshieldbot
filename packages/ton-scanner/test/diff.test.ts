import { describe, expect, it } from "vitest";
import type { EmulatedAction } from "@tonshield/ton-emulator";
import { diffStaticVsEmulated } from "../src/transaction/diff.ts";
import type { ParsedMessage } from "../src/transaction/types.ts";

// Canonical raw addresses for assertions. Three distinct accounts so we can
// pair, mismatch, and add hidden recipients without collisions.
const ADDR_A_RAW = "0:cdce58745d265d6f9fd0ae5c79423c991d500eef8bf9a0c79556bb45ff956dd6";
const ADDR_B_RAW = "0:10c71a73c661155342eef14d33353c41cd72163efa36eb74c837539033d62fc6";
const ADDR_C_RAW = "0:abcdef0000000000000000000000000000000000000000000000000000000000";

// Friendly form of ADDR_A — diff must canonicalise both sides and treat
// EQ/UQ friendly addresses as equal to their raw counterparts.
const ADDR_A_FRIENDLY = "UQDNzlh0XSZdb5_Qrlx5QjyZHVAO74v5oMeVVrtF_5Vt1rIt";

const staticTonSend = (to: string, valueNano: bigint): ParsedMessage => ({
  to,
  value: valueNano,
  bounce: false,
  payload: { kind: "none" },
  hasStateInit: false,
});

const staticTonComment = (to: string, valueNano: bigint, text: string): ParsedMessage => ({
  to,
  value: valueNano,
  bounce: false,
  payload: { kind: "ton_comment", text },
  hasStateInit: false,
});

const staticJettonTransfer = (to: string, valueNano: bigint): ParsedMessage => ({
  to,
  value: valueNano,
  bounce: true,
  payload: {
    kind: "jetton_transfer",
    queryId: 1n,
    amount: 1_000n,
    destination: ADDR_A_RAW,
    responseDestination: null,
    forwardAmount: 0n,
  },
  hasStateInit: false,
});

const staticDeployIntent = (to: string, valueNano: bigint): ParsedMessage => ({
  to,
  value: valueNano,
  bounce: false,
  payload: { kind: "none" },
  hasStateInit: true,
});

const emulatedTonTransfer = (recipientRaw: string, amountNano: bigint): EmulatedAction => ({
  kind: "ton_transfer",
  status: "ok",
  simplePreview: "ignored — diff must not parse this",
  rawType: "TonTransfer",
  details: { kind: "ton_transfer", recipient: recipientRaw, amountNano },
});

const emulatedJettonTransfer = (): EmulatedAction => ({
  kind: "jetton_transfer",
  status: "ok",
  simplePreview: "Transfer 100 USDT",
  rawType: "JettonTransfer",
  details: null,
});

const emulatedContractDeploy = (addressRaw: string): EmulatedAction => ({
  kind: "contract_deploy",
  status: "ok",
  simplePreview: "Deploy NFT item",
  rawType: "ContractDeploy",
  details: { kind: "contract_deploy", address: addressRaw, interfaces: ["nft_item"] },
});

describe("diffStaticVsEmulated — happy path", () => {
  it("returns no mismatches or hidden actions when a single TON send pair matches exactly", () => {
    const result = diffStaticVsEmulated({
      staticMessages: [staticTonSend(ADDR_A_RAW, 10_000_000n)],
      emulatedActions: [emulatedTonTransfer(ADDR_A_RAW, 10_000_000n)],
    });

    expect(result.mismatches).toEqual([]);
    expect(result.hiddenActions).toEqual([]);
  });

  it("treats EQ/UQ friendly form as equal to raw form (canonicalisation)", () => {
    // Static uses UQ friendly form, emulated returns raw form. Diff must
    // canonicalise both before comparing.
    const result = diffStaticVsEmulated({
      staticMessages: [staticTonSend(ADDR_A_FRIENDLY, 10_000_000n)],
      emulatedActions: [emulatedTonTransfer(ADDR_A_RAW, 10_000_000n)],
    });

    expect(result.mismatches).toEqual([]);
    expect(result.hiddenActions).toEqual([]);
  });

  it("pairs ton_comment sends with emulated ton_transfer (commented sends are comparable)", () => {
    const result = diffStaticVsEmulated({
      staticMessages: [staticTonComment(ADDR_A_RAW, 5_000_000n, "salary")],
      emulatedActions: [emulatedTonTransfer(ADDR_A_RAW, 5_000_000n)],
    });

    expect(result.mismatches).toEqual([]);
    expect(result.hiddenActions).toEqual([]);
  });
});

describe("diffStaticVsEmulated — destination mismatch", () => {
  it("flags a destination mismatch with both addresses in evidence", () => {
    const result = diffStaticVsEmulated({
      staticMessages: [staticTonSend(ADDR_A_FRIENDLY, 10_000_000n)],
      emulatedActions: [emulatedTonTransfer(ADDR_C_RAW, 10_000_000n)],
    });

    expect(result.mismatches).toEqual([
      {
        kind: "ton_transfer_destination",
        messageIndex: 0,
        staticDestination: ADDR_A_FRIENDLY,
        emulatedDestination: ADDR_C_RAW,
      },
    ]);
    expect(result.hiddenActions).toEqual([]);
  });

  it("does NOT also flag an amount mismatch on the same pair when destinations disagree", () => {
    // When destinations don't match, the amount comparison is meaningless
    // — they're different transfers. Only the destination mismatch fires.
    const result = diffStaticVsEmulated({
      staticMessages: [staticTonSend(ADDR_A_RAW, 10_000_000n)],
      emulatedActions: [emulatedTonTransfer(ADDR_C_RAW, 999_999_999n)],
    });

    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]?.kind).toBe("ton_transfer_destination");
  });
});

describe("diffStaticVsEmulated — amount mismatch", () => {
  it("flags an amount mismatch when destinations agree but amounts differ", () => {
    const result = diffStaticVsEmulated({
      staticMessages: [staticTonSend(ADDR_A_RAW, 10_000_000n)],
      emulatedActions: [emulatedTonTransfer(ADDR_A_RAW, 999_999_999n)],
    });

    expect(result.mismatches).toEqual([
      {
        kind: "ton_transfer_amount",
        messageIndex: 0,
        destination: ADDR_A_RAW,
        staticAmountNano: "10000000",
        emulatedAmountNano: "999999999",
      },
    ]);
  });
});

describe("diffStaticVsEmulated — hidden actions", () => {
  it("flags an extra emulated TonTransfer with no static counterpart as a hidden action", () => {
    const result = diffStaticVsEmulated({
      staticMessages: [staticTonSend(ADDR_A_RAW, 10_000_000n)],
      emulatedActions: [
        emulatedTonTransfer(ADDR_A_RAW, 10_000_000n),
        emulatedTonTransfer(ADDR_C_RAW, 50_000_000n),
      ],
    });

    expect(result.mismatches).toEqual([]);
    expect(result.hiddenActions).toEqual([
      {
        emulatedActionIndex: 1,
        kind: "ton_transfer",
        recipient: ADDR_C_RAW,
        amountNano: "50000000",
        rawType: "TonTransfer",
      },
    ]);
  });

  it("preserves the emulatedActionIndex from the original (unfiltered) actions array", () => {
    // Mix: jetton transfer at index 0, ton transfer at index 1, extra ton
    // transfer at index 2. The hidden action's `emulatedActionIndex` must
    // reference position 2 in the original array, not position 1 in the
    // filtered ton-transfer-only subsequence.
    const result = diffStaticVsEmulated({
      staticMessages: [staticTonSend(ADDR_A_RAW, 10_000_000n)],
      emulatedActions: [
        emulatedJettonTransfer(),
        emulatedTonTransfer(ADDR_A_RAW, 10_000_000n),
        emulatedTonTransfer(ADDR_C_RAW, 50_000_000n),
      ],
    });

    expect(result.hiddenActions[0]?.emulatedActionIndex).toBe(2);
  });
});

describe("diffStaticVsEmulated — out-of-scope kinds", () => {
  it("ignores static jetton transfers (out of PR-D2 scope, no false-pair attempt)", () => {
    // Static jetton transfer must not be paired with anything. Emulated
    // jetton transfer must not be paired either. Both sides drop out and
    // the diff is empty.
    const result = diffStaticVsEmulated({
      staticMessages: [staticJettonTransfer(ADDR_A_RAW, 100_000n)],
      emulatedActions: [emulatedJettonTransfer()],
    });

    expect(result.mismatches).toEqual([]);
    expect(result.hiddenActions).toEqual([]);
  });

  it("ignores static deploy intents (hasStateInit excludes from TON-send pairing)", () => {
    // A static message with stateInit is a deploy, not a TON transfer.
    // Even though it would otherwise look like a `send_ton` (payload.kind ===
    // "none"), the hasStateInit flag excludes it from diff scope. The
    // companion `EMULATION_DEPLOYS_UNKNOWN_CONTRACT` rule handles deploys
    // separately in the scanner.
    const result = diffStaticVsEmulated({
      staticMessages: [staticDeployIntent(ADDR_A_RAW, 10_000_000n)],
      emulatedActions: [emulatedContractDeploy(ADDR_A_RAW)],
    });

    expect(result.mismatches).toEqual([]);
    expect(result.hiddenActions).toEqual([]);
  });

  it("ignores emulated ton_transfer actions that have no structured details (defensive)", () => {
    // TONAPI sometimes returns an Action with type=TonTransfer but no
    // TonTransfer subobject (failed boundary cases). We must not crash
    // and must not invent destination/amount — just skip the action.
    const malformedEmulated: EmulatedAction = {
      kind: "ton_transfer",
      status: "failed",
      simplePreview: "Failed",
      rawType: "TonTransfer",
      details: null,
    };

    const result = diffStaticVsEmulated({
      staticMessages: [staticTonSend(ADDR_A_RAW, 10_000_000n)],
      emulatedActions: [malformedEmulated],
    });

    // No mismatch (the static side has no comparable emulated counterpart
    // because the malformed one is filtered out), and no hidden action.
    expect(result.mismatches).toEqual([]);
    expect(result.hiddenActions).toEqual([]);
  });

  it("does NOT flag the static-only case as a mismatch (TONAPI re-classification is benign)", () => {
    // Static expected a TON send at index 0, emulator returned a
    // SmartContractExec instead (e.g. because the destination is a
    // recognised contract). This is a labelling difference, not a
    // contradiction — no mismatch.
    const smartContractExec: EmulatedAction = {
      kind: "smart_contract_exec",
      status: "ok",
      simplePreview: "Contract call",
      rawType: "SmartContractExec",
      details: null,
    };

    const result = diffStaticVsEmulated({
      staticMessages: [staticTonSend(ADDR_A_RAW, 10_000_000n)],
      emulatedActions: [smartContractExec],
    });

    expect(result.mismatches).toEqual([]);
    expect(result.hiddenActions).toEqual([]);
  });
});

describe("diffStaticVsEmulated — multi-message pairing", () => {
  it("pairs multiple TON sends positionally and flags only the mismatched one", () => {
    const result = diffStaticVsEmulated({
      staticMessages: [
        staticTonSend(ADDR_A_RAW, 10_000_000n),
        staticTonSend(ADDR_B_RAW, 20_000_000n),
      ],
      emulatedActions: [
        emulatedTonTransfer(ADDR_A_RAW, 10_000_000n), // matches
        emulatedTonTransfer(ADDR_C_RAW, 20_000_000n), // destination mismatch
      ],
    });

    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({
      kind: "ton_transfer_destination",
      messageIndex: 1,
    });
  });

  it("walks position-aligned within filtered subsequences, ignoring interleaved non-TON actions", () => {
    // Static: [ton-send-A, jetton, ton-send-B]
    // Emulated: [jetton, ton-A, ton-B]
    // Comparable statics after filter: [ton-send-A (orig idx 0), ton-send-B (orig idx 2)]
    // Comparable emulated after filter: [ton-A (orig idx 1), ton-B (orig idx 2)]
    // Pair them — both match — no mismatch.
    const result = diffStaticVsEmulated({
      staticMessages: [
        staticTonSend(ADDR_A_RAW, 10_000_000n),
        staticJettonTransfer(ADDR_C_RAW, 1n),
        staticTonSend(ADDR_B_RAW, 20_000_000n),
      ],
      emulatedActions: [
        emulatedJettonTransfer(),
        emulatedTonTransfer(ADDR_A_RAW, 10_000_000n),
        emulatedTonTransfer(ADDR_B_RAW, 20_000_000n),
      ],
    });

    expect(result.mismatches).toEqual([]);
    expect(result.hiddenActions).toEqual([]);
  });

  it("flags messageIndex referencing the ORIGINAL static array (not the filtered subsequence)", () => {
    const result = diffStaticVsEmulated({
      staticMessages: [
        staticJettonTransfer(ADDR_C_RAW, 1n), // orig idx 0, excluded
        staticTonSend(ADDR_A_RAW, 10_000_000n), // orig idx 1
      ],
      emulatedActions: [emulatedTonTransfer(ADDR_C_RAW, 10_000_000n)],
    });

    expect(result.mismatches[0]?.messageIndex).toBe(1);
  });
});
