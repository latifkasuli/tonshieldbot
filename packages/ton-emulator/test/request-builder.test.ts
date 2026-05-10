import { Address, beginCell, Cell, loadMessage } from "@ton/core";
import { describe, expect, it } from "vitest";
import {
  buildExternalMessageBoc,
  networkGlobalIds,
  type BuildExternalMessageInput,
  type TonConnectMessage,
} from "../src/request-builder.ts";

// Deterministic 64-byte secret key. Real keys are derived from a mnemonic but
// the wallet contract only reads it to sign — for emulation, any 64 bytes is
// equivalent because TONAPI bypasses the on-chain signature check (verified
// empirically in PR-B).
const FIXED_DUMMY_SECRET = Buffer.alloc(64, 0x42);

// 32-byte public key. Doesn't have to correspond to FIXED_DUMMY_SECRET — the
// wallet builds its address from this, the signer signs with the secret. The
// mismatch is fine because TONAPI doesn't check.
const FIXED_PUBLIC_KEY = Buffer.alloc(32, 0x01);

const SENDER_ADDRESS = Address.parseRaw(
  "0:0000000000000000000000000000000000000000000000000000000000000000",
);
const RECIPIENT_ADDRESS = Address.parseRaw(
  "0:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
);

const baseInput = (
  overrides: Partial<BuildExternalMessageInput> = {},
): BuildExternalMessageInput => ({
  walletVersion: "v4r2",
  senderAddress: SENDER_ADDRESS,
  publicKey: FIXED_PUBLIC_KEY,
  seqno: 0,
  networkGlobalId: networkGlobalIds.mainnet,
  messages: [{ address: RECIPIENT_ADDRESS.toString(), amount: "100000000" }],
  dummySecretKeyOverride: FIXED_DUMMY_SECRET,
  ...overrides,
});

const decodeExternalMessage = (boc: string) => {
  const cell = Cell.fromBase64(boc);
  return loadMessage(cell.beginParse());
};

describe("buildExternalMessageBoc", () => {
  it("produces a base64 BOC for a V4R2 sender", async () => {
    const boc = await buildExternalMessageBoc(baseInput());

    expect(typeof boc).toBe("string");
    expect(boc.length).toBeGreaterThan(0);
    // Round-trip parse — confirms the bytes are a well-formed Cell
    expect(() => decodeExternalMessage(boc)).not.toThrow();
  });

  it("produces a base64 BOC for a V3R2 sender", async () => {
    const boc = await buildExternalMessageBoc(baseInput({ walletVersion: "v3r2" }));

    expect(() => decodeExternalMessage(boc)).not.toThrow();
  });

  it("produces a base64 BOC for a V5R1 sender on mainnet", async () => {
    const boc = await buildExternalMessageBoc(
      baseInput({ walletVersion: "v5r1", networkGlobalId: networkGlobalIds.mainnet }),
    );

    expect(() => decodeExternalMessage(boc)).not.toThrow();
  });

  it("produces a base64 BOC for a V5R1 sender on testnet (different walletId)", async () => {
    const boc = await buildExternalMessageBoc(
      baseInput({ walletVersion: "v5r1", networkGlobalId: networkGlobalIds.testnet }),
    );

    expect(() => decodeExternalMessage(boc)).not.toThrow();
  });

  it("V5R1 mainnet and testnet BOCs differ (walletId is wired through)", async () => {
    const mainnet = await buildExternalMessageBoc(
      baseInput({ walletVersion: "v5r1", networkGlobalId: networkGlobalIds.mainnet }),
    );
    const testnet = await buildExternalMessageBoc(
      baseInput({ walletVersion: "v5r1", networkGlobalId: networkGlobalIds.testnet }),
    );

    expect(mainnet).not.toBe(testnet);
  });

  it("the wrapped message is an external_in to the sender address", async () => {
    const boc = await buildExternalMessageBoc(baseInput());
    const message = decodeExternalMessage(boc);

    expect(message.info.type).toBe("external-in");

    if (message.info.type === "external-in") {
      // The wallet sends an external-in addressed to itself — `dest` is the
      // sender wallet address (which becomes the on-chain executor).
      expect(message.info.dest.equals(SENDER_ADDRESS)).toBe(true);
      // `src` is `addr_none` for external-in (no on-chain sender).
      expect(message.info.src).toBeNull();
    }
  });

  it("attaches a body cell (signed transfer) to the external message", async () => {
    const boc = await buildExternalMessageBoc(baseInput());
    const message = decodeExternalMessage(boc);

    expect(message.body).toBeInstanceOf(Cell);
    expect(message.body.bits.length).toBeGreaterThan(0);
  });

  it("produces deterministic output when the dummy secret is fixed", async () => {
    // Same inputs + same dummy secret → byte-identical BOCs. This is what
    // makes the per-version assertions above stable across runs.
    const a = await buildExternalMessageBoc(baseInput());
    const b = await buildExternalMessageBoc(baseInput());

    expect(a).toBe(b);
  });

  it("encodes a payload BOC into the internal message body", async () => {
    const payloadCell = beginCell().storeUint(0xdeadbeef, 32).endCell();
    const payload = payloadCell.toBoc().toString("base64");
    const message: TonConnectMessage = {
      address: RECIPIENT_ADDRESS.toString(),
      amount: "1000000000",
      payload,
    };

    const boc = await buildExternalMessageBoc(baseInput({ messages: [message] }));

    // Just verify the BOC parses and round-trip works; deeper internal-message
    // inspection requires walking the wallet's signed body, which we leave to
    // the integration smoke test rather than reimplementing the wallet here.
    expect(() => decodeExternalMessage(boc)).not.toThrow();
  });

  it("encodes a stateInit BOC for contract deployment", async () => {
    // Minimal-but-valid stateInit: code + data, no library / split-depth.
    const stateInitCell = beginCell()
      .storeBit(false) // split_depth: nothing
      .storeBit(false) // special: nothing
      .storeBit(true) // code: present
      .storeRef(beginCell().storeUint(0, 32).endCell())
      .storeBit(true) // data: present
      .storeRef(beginCell().endCell())
      .storeBit(false) // library: nothing
      .endCell();
    const stateInit = stateInitCell.toBoc().toString("base64");

    const boc = await buildExternalMessageBoc(
      baseInput({
        messages: [{ address: RECIPIENT_ADDRESS.toString(), amount: "50000000", stateInit }],
      }),
    );

    expect(() => decodeExternalMessage(boc)).not.toThrow();
  });

  it("supports multiple messages in a single transfer", async () => {
    const boc = await buildExternalMessageBoc(
      baseInput({
        messages: [
          { address: RECIPIENT_ADDRESS.toString(), amount: "100000000" },
          { address: SENDER_ADDRESS.toString(), amount: "50000000" },
          { address: RECIPIENT_ADDRESS.toString(), amount: "25000000" },
        ],
      }),
    );

    expect(() => decodeExternalMessage(boc)).not.toThrow();
  });

  it("rejects malformed amount strings via BigInt", async () => {
    await expect(
      buildExternalMessageBoc(
        baseInput({
          messages: [{ address: RECIPIENT_ADDRESS.toString(), amount: "not-a-number" }],
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects malformed destination addresses", async () => {
    await expect(
      buildExternalMessageBoc(
        baseInput({
          messages: [{ address: "definitely-not-an-address", amount: "100" }],
        }),
      ),
    ).rejects.toThrow();
  });

  it("generates a fresh dummy secret when no override is passed", async () => {
    // Without `dummySecretKeyOverride`, two builds should produce different
    // BOCs because the embedded signature differs. (Wallet body includes the
    // signature even though TONAPI ignores it.)
    const input = baseInput();
    delete (input as { dummySecretKeyOverride?: Buffer }).dummySecretKeyOverride;

    const a = await buildExternalMessageBoc(input);
    const b = await buildExternalMessageBoc(input);

    expect(a).not.toBe(b);
  });
});
