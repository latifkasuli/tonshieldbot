import { Address, beginCell } from "@ton/core";
import { describe, expect, it } from "vitest";
import { decodePayload } from "../src/transaction/payload-decoder.ts";
import { parseMessages } from "../src/transaction/message-parser.ts";
import {
  classifyMessage,
  formatNano,
  shortenAddress,
} from "../src/transaction/action-classifier.ts";
import { scanTransactionJson } from "../src/transaction/scanner.ts";
import type { TransactionJsonInput } from "@tonshield/shared";

// Raw-format addresses are accepted by Address.parse and need no checksum
const KNOWN_ADDRESS = "0:0000000000000000000000000000000000000000000000000000000000000000";
const ANOTHER_ADDRESS = "0:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

const parseAddr = (raw: string) => Address.parseRaw(raw);

// ── BOC helpers ──────────────────────────────────────────────────────────────

const buildCommentBoc = (text: string): string =>
  beginCell().storeUint(0, 32).storeStringTail(text).endCell().toBoc().toString("base64");

const buildJettonTransferBoc = (opts: {
  amount: bigint;
  destination: string;
  responseDestination?: string | null;
}): string => {
  const dest = parseAddr(opts.destination);
  const responseAddr =
    opts.responseDestination != null ? parseAddr(opts.responseDestination) : null;

  return (
    beginCell()
      .storeUint(0x0f8a7ea5, 32)
      .storeUint(1n, 64) // query_id
      .storeCoins(opts.amount)
      .storeAddress(dest)
      // response_destination is MsgAddress (addr_none if null)
      .storeAddress(responseAddr)
      .storeBit(false) // no custom_payload
      .storeCoins(0n) // forward_ton_amount
      .storeBit(false) // forward_payload inline
      .endCell()
      .toBoc()
      .toString("base64")
  );
};

const buildNftTransferBoc = (opts: {
  newOwner: string;
  responseDestination?: string | null;
}): string => {
  const owner = parseAddr(opts.newOwner);
  const responseAddr =
    opts.responseDestination != null ? parseAddr(opts.responseDestination) : null;

  return beginCell()
    .storeUint(0x5fcc3d14, 32)
    .storeUint(0n, 64)
    .storeAddress(owner)
    .storeAddress(responseAddr)
    .storeBit(false) // no custom_payload
    .storeCoins(0n) // forward_amount
    .storeBit(false) // forward_payload inline
    .endCell()
    .toBoc()
    .toString("base64");
};

const buildOpaqueBoc = (opCode: number): string =>
  beginCell().storeUint(opCode, 32).storeUint(0, 64).endCell().toBoc().toString("base64");

// ── decodePayload ─────────────────────────────────────────────────────────────

describe("decodePayload", () => {
  it("returns none for empty string", () => {
    expect(decodePayload("")).toEqual({ kind: "none" });
  });

  it("decodes text comment", () => {
    const boc = buildCommentBoc("Hello, TON!");
    const result = decodePayload(boc);

    expect(result).toMatchObject({ kind: "ton_comment", text: "Hello, TON!" });
  });

  it("decodes empty comment (op=0, no trailing text)", () => {
    const boc = beginCell().storeUint(0, 32).endCell().toBoc().toString("base64");
    const result = decodePayload(boc);

    expect(result).toMatchObject({ kind: "ton_comment", text: "" });
  });

  it("decodes jetton transfer with non-null response_destination", () => {
    // Verifies fix: response_destination uses loadMaybeAddress(), not loadBit()
    const boc = buildJettonTransferBoc({
      amount: 1_000_000_000n,
      destination: KNOWN_ADDRESS,
      responseDestination: ANOTHER_ADDRESS,
    });
    const result = decodePayload(boc);

    expect(result.kind).toBe("jetton_transfer");

    if (result.kind === "jetton_transfer") {
      expect(result.queryId).toBe(1n);
      expect(result.amount).toBe(1_000_000_000n);
      expect(result.responseDestination).not.toBeNull();
    }
  });

  it("decodes jetton transfer with addr_none response_destination", () => {
    const boc = buildJettonTransferBoc({
      amount: 500_000_000n,
      destination: KNOWN_ADDRESS,
      responseDestination: null,
    });
    const result = decodePayload(boc);

    expect(result.kind).toBe("jetton_transfer");

    if (result.kind === "jetton_transfer") {
      expect(result.responseDestination).toBeNull();
    }
  });

  it("decodes NFT transfer with non-null response_destination", () => {
    const boc = buildNftTransferBoc({
      newOwner: ANOTHER_ADDRESS,
      responseDestination: KNOWN_ADDRESS,
    });
    const result = decodePayload(boc);

    expect(result.kind).toBe("nft_transfer");

    if (result.kind === "nft_transfer") {
      expect(result.responseDestination).not.toBeNull();
    }
  });

  it("treats a non-empty cell with fewer than 32 bits as opaque", () => {
    // A cell that has bits but not enough for an op code should not look like a plain transfer
    const boc = beginCell().storeUint(0x0f, 8).endCell().toBoc().toString("base64");
    const result = decodePayload(boc);

    expect(result).toMatchObject({ kind: "opaque", opCode: null });
  });

  it("returns opaque for unknown op code", () => {
    const boc = buildOpaqueBoc(0xdeadbeef);
    const result = decodePayload(boc);

    expect(result).toMatchObject({ kind: "opaque", opCode: 0xdeadbeef });
  });

  it("returns opaque for invalid base64", () => {
    expect(decodePayload("not-valid-base64!!!")).toMatchObject({ kind: "opaque", opCode: null });
  });
});

// ── parseMessages ─────────────────────────────────────────────────────────────

describe("parseMessages", () => {
  it("parses a TON Connect style messages array", () => {
    const tx = {
      messages: [
        { address: KNOWN_ADDRESS, amount: "500000000" },
        { address: ANOTHER_ADDRESS, amount: "100000000" },
      ],
    };

    const { parsed, malformedCount } = parseMessages(tx);

    expect(parsed).toHaveLength(2);
    expect(malformedCount).toBe(0);
    expect(parsed[0]?.value).toBe(500_000_000n);
    expect(parsed[1]?.value).toBe(100_000_000n);
  });

  it("counts messages with invalid addresses as malformed", () => {
    const tx = {
      messages: [
        { address: "not-an-address", amount: "100" },
        { address: KNOWN_ADDRESS, amount: "200000000" },
      ],
    };

    const { parsed, malformedCount } = parseMessages(tx);

    expect(parsed).toHaveLength(1);
    expect(malformedCount).toBe(1);
    expect(parsed[0]?.value).toBe(200_000_000n);
  });

  it("counts messages with negative amounts as malformed", () => {
    const tx = {
      messages: [{ address: KNOWN_ADDRESS, amount: "-100" }],
    };

    const { parsed, malformedCount } = parseMessages(tx);

    expect(parsed).toHaveLength(0);
    expect(malformedCount).toBe(1);
  });

  it("counts messages with decimal amounts as malformed", () => {
    const { malformedCount } = parseMessages({
      messages: [{ address: KNOWN_ADDRESS, amount: "1.5" }],
    });

    expect(malformedCount).toBe(1);
  });

  it("rejects unsafe numeric amounts (> MAX_SAFE_INTEGER)", () => {
    // 2 ** 53 = MAX_SAFE_INTEGER + 1; representable exactly in float64 but outside safe range
    const { malformedCount } = parseMessages({
      messages: [{ address: KNOWN_ADDRESS, amount: 2 ** 53 }],
    });

    expect(malformedCount).toBe(1);
  });

  it("falls back to single-message format when messages array is absent", () => {
    const { parsed, malformedCount } = parseMessages({
      address: KNOWN_ADDRESS,
      amount: "100000000",
    });

    expect(parsed).toHaveLength(1);
    expect(malformedCount).toBe(0);
  });

  it("treats absent amount as malformed (amount is required per TON Connect spec)", () => {
    const { parsed, malformedCount } = parseMessages({ messages: [{ address: KNOWN_ADDRESS }] });

    expect(parsed).toHaveLength(0);
    expect(malformedCount).toBe(1);
  });

  it("detects stateInit presence", () => {
    const tx = {
      messages: [{ address: KNOWN_ADDRESS, amount: "50000000", stateInit: "te6cckEBAQEAAgAAAA==" }],
    };

    const { parsed } = parseMessages(tx);

    expect(parsed[0]?.hasStateInit).toBe(true);
  });
});

// ── formatNano ────────────────────────────────────────────────────────────────

describe("formatNano", () => {
  it("formats whole TON amounts", () => {
    expect(formatNano(1_000_000_000n)).toBe("1 TON");
    expect(formatNano(5_000_000_000n)).toBe("5 TON");
  });

  it("formats fractional TON amounts", () => {
    expect(formatNano(500_000_000n)).toBe("0.5 TON");
    expect(formatNano(1_500_000_000n)).toBe("1.5 TON");
    expect(formatNano(100_000_000n)).toBe("0.1 TON");
  });

  it("trims trailing fraction zeros", () => {
    expect(formatNano(1_100_000_000n)).toBe("1.1 TON");
    expect(formatNano(1_010_000_000n)).toBe("1.01 TON");
  });

  it("handles zero", () => {
    expect(formatNano(0n)).toBe("0 TON");
  });
});

// ── AssetDelta amount does not double-label ───────────────────────────────────

describe("AssetDelta TON amount", () => {
  it("stores decimal string without TON suffix so symbol can be appended separately", () => {
    const action = classifyMessage({
      to: parseAddr(KNOWN_ADDRESS).toString({ bounceable: true }),
      value: 1_500_000_000n,
      bounce: true,
      payload: { kind: "none" },
      hasStateInit: false,
    });

    const tonDelta = action.assetDeltas.find((d) => d.assetType === "ton");

    expect(tonDelta?.amount).toBe("1.5");
    expect(tonDelta?.symbol).toBe("TON");
  });
});

// ── shortenAddress ────────────────────────────────────────────────────────────

describe("shortenAddress", () => {
  const longAddress = parseAddr(KNOWN_ADDRESS).toString({ bounceable: true });

  it("shortens long addresses", () => {
    expect(shortenAddress(longAddress).length).toBeLessThan(longAddress.length);
    expect(shortenAddress(longAddress)).toContain("…");
  });

  it("leaves short addresses unchanged", () => {
    expect(shortenAddress("short")).toBe("short");
  });
});

// ── classifyMessage ───────────────────────────────────────────────────────────

describe("classifyMessage", () => {
  const knownAddr = parseAddr(KNOWN_ADDRESS).toString({ bounceable: true });
  const otherAddr = parseAddr(ANOTHER_ADDRESS).toString({ bounceable: true });

  it("classifies plain TON send", () => {
    const action = classifyMessage({
      to: knownAddr,
      value: 1_000_000_000n,
      bounce: true,
      payload: { kind: "none" },
      hasStateInit: false,
    });

    expect(action.kind).toBe("send_ton");
    expect(action.assetDeltas[0]?.assetType).toBe("ton");
    expect(action.assetDeltas[0]?.direction).toBe("outgoing");
  });

  it("classifies contract deploy regardless of payload", () => {
    const action = classifyMessage({
      to: knownAddr,
      value: 50_000_000n,
      bounce: false,
      payload: { kind: "none" },
      hasStateInit: true,
    });

    expect(action.kind).toBe("deploy_contract");
  });

  it("classifies jetton transfer", () => {
    const action = classifyMessage({
      to: knownAddr,
      value: 200_000_000n,
      bounce: true,
      payload: {
        kind: "jetton_transfer",
        queryId: 0n,
        amount: 5_000_000_000n,
        destination: otherAddr,
        responseDestination: null,
        forwardAmount: 0n,
      },
      hasStateInit: false,
    });

    expect(action.kind).toBe("send_jetton");
    expect(action.assetDeltas.some((d) => d.assetType === "jetton")).toBe(true);
  });

  it("classifies NFT transfer", () => {
    const action = classifyMessage({
      to: knownAddr,
      value: 100_000_000n,
      bounce: true,
      payload: {
        kind: "nft_transfer",
        queryId: 0n,
        newOwner: otherAddr,
        responseDestination: null,
        forwardAmount: 0n,
      },
      hasStateInit: false,
    });

    expect(action.kind).toBe("send_nft");
  });

  it("classifies opaque payload as unknown", () => {
    const action = classifyMessage({
      to: knownAddr,
      value: 0n,
      bounce: true,
      payload: { kind: "opaque", opCode: 0x12345678 },
      hasStateInit: false,
    });

    expect(action.kind).toBe("unknown");
  });
});

// ── scanTransactionJson ───────────────────────────────────────────────────────

describe("scanTransactionJson", () => {
  const makeInput = (transaction: Record<string, unknown>): TransactionJsonInput => ({
    kind: "transaction_json",
    raw: JSON.stringify(transaction),
    normalized: JSON.stringify(transaction),
    transaction,
  });

  it("returns no findings for a clean send_ton", () => {
    const result = scanTransactionJson(
      makeInput({ messages: [{ address: KNOWN_ADDRESS, amount: "1000000000" }] }),
    );

    expect(result.findings).toHaveLength(0);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.kind).toBe("send_ton");
  });

  it("raises TRANSACTION_OPAQUE_PAYLOAD for unknown op codes", () => {
    const boc = buildOpaqueBoc(0xdeadbeef);
    const result = scanTransactionJson(
      makeInput({ messages: [{ address: KNOWN_ADDRESS, amount: "0", payload: boc }] }),
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe("TRANSACTION_OPAQUE_PAYLOAD");
    expect(result.actions[0]?.kind).toBe("unknown");
  });

  it("raises TRANSACTION_MALFORMED_MESSAGE when all messages have invalid addresses", () => {
    const result = scanTransactionJson(
      makeInput({ messages: [{ address: "bad", amount: "100" }] }),
    );

    expect(result.actions).toHaveLength(0);
    expect(result.findings.some((f) => f.ruleId === "TRANSACTION_MALFORMED_MESSAGE")).toBe(true);
  });

  it("raises TRANSACTION_MALFORMED_MESSAGE for negative amounts", () => {
    const result = scanTransactionJson(
      makeInput({ messages: [{ address: KNOWN_ADDRESS, amount: "-500" }] }),
    );

    expect(result.findings.some((f) => f.ruleId === "TRANSACTION_MALFORMED_MESSAGE")).toBe(true);
  });

  it("produces one opaque finding per unrecognised message", () => {
    const boc = buildOpaqueBoc(0x11223344);
    const result = scanTransactionJson(
      makeInput({
        messages: [
          { address: KNOWN_ADDRESS, amount: "0", payload: boc },
          { address: ANOTHER_ADDRESS, amount: "0", payload: boc },
        ],
      }),
    );

    expect(result.findings).toHaveLength(2);
  });

  it("raises TRANSACTION_MALFORMED_MESSAGE for an empty messages array", () => {
    const result = scanTransactionJson(makeInput({ messages: [] }));

    expect(result.actions).toHaveLength(0);
    expect(result.findings.some((f) => f.ruleId === "TRANSACTION_MALFORMED_MESSAGE")).toBe(true);
  });

  it("parses transaction with comment payload", () => {
    const boc = buildCommentBoc("payment for services");
    const result = scanTransactionJson(
      makeInput({ messages: [{ address: KNOWN_ADDRESS, amount: "2000000000", payload: boc }] }),
    );

    expect(result.findings).toHaveLength(0);
    expect(result.actions[0]?.kind).toBe("send_ton");
    expect(result.actions[0]?.title).toBe("Send TON with comment");
  });

  it("raises TRANSACTION_MALFORMED_MESSAGE when amount field is absent", () => {
    const result = scanTransactionJson(makeInput({ messages: [{ address: KNOWN_ADDRESS }] }));

    expect(result.actions).toHaveLength(0);
    expect(result.findings.some((f) => f.ruleId === "TRANSACTION_MALFORMED_MESSAGE")).toBe(true);
  });

  it("raises both malformed and opaque findings in the same transaction", () => {
    const boc = buildOpaqueBoc(0xabcd1234);
    const result = scanTransactionJson(
      makeInput({
        messages: [
          { address: "bad-address", amount: "100" }, // malformed
          { address: KNOWN_ADDRESS, amount: "0", payload: boc }, // opaque
        ],
      }),
    );

    expect(result.findings.some((f) => f.ruleId === "TRANSACTION_MALFORMED_MESSAGE")).toBe(true);
    expect(result.findings.some((f) => f.ruleId === "TRANSACTION_OPAQUE_PAYLOAD")).toBe(true);
    expect(result.actions[0]?.kind).toBe("unknown");
  });
});
