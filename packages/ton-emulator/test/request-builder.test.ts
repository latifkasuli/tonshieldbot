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

  it("rejects raw-form destination addresses (TON Connect requires friendly form)", async () => {
    // Per the spec, TON Connect destinations must be user-friendly (EQ/UQ) so
    // the wallet can derive the bounce flag from the encoding. Accepting raw
    // form would force us to pick a hardcoded bounce value, which would make
    // emulation diverge from the real wallet's behaviour for non-bounceable
    // destinations.
    await expect(
      buildExternalMessageBoc(
        baseInput({
          messages: [
            {
              address: "0:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
              amount: "100",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/user-friendly address/);
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

  // ── bounce flag derivation (regression: builder used to hardcode true) ──

  it("derives bounce=true from an EQ-prefixed destination address", async () => {
    const eqForm = RECIPIENT_ADDRESS.toString({ bounceable: true, urlSafe: true });
    expect(eqForm.startsWith("EQ")).toBe(true);

    const boc = await buildExternalMessageBoc(
      baseInput({ messages: [{ address: eqForm, amount: "100000000" }] }),
    );

    expect(() => decodeExternalMessage(boc)).not.toThrow();
  });

  it("derives bounce=false from a UQ-prefixed destination address", async () => {
    const uqForm = RECIPIENT_ADDRESS.toString({ bounceable: false, urlSafe: true });
    expect(uqForm.startsWith("UQ")).toBe(true);

    const boc = await buildExternalMessageBoc(
      baseInput({ messages: [{ address: uqForm, amount: "100000000" }] }),
    );

    expect(() => decodeExternalMessage(boc)).not.toThrow();
  });

  it("EQ and UQ destinations produce different BOCs (bounce flag is wired through)", async () => {
    // Bounceable and non-bounceable copies of the same address must round-trip
    // through the wallet transfer with different `bounce` bits, producing
    // different external-message bytes. If they were identical, our builder
    // would be silently ignoring the friendly-form bounce flag — the exact
    // bug PR #16 review caught.
    const eqForm = RECIPIENT_ADDRESS.toString({ bounceable: true, urlSafe: true });
    const uqForm = RECIPIENT_ADDRESS.toString({ bounceable: false, urlSafe: true });

    const eqBoc = await buildExternalMessageBoc(
      baseInput({ messages: [{ address: eqForm, amount: "100000000" }] }),
    );
    const uqBoc = await buildExternalMessageBoc(
      baseInput({ messages: [{ address: uqForm, amount: "100000000" }] }),
    );

    expect(eqBoc).not.toBe(uqBoc);
  });

  // ── extra-currency support ──

  it("accepts an empty extraCurrency map as equivalent to omitted", async () => {
    const withEmpty = await buildExternalMessageBoc(
      baseInput({
        messages: [
          {
            address: RECIPIENT_ADDRESS.toString(),
            amount: "100000000",
            extraCurrency: {},
          },
        ],
      }),
    );
    const withoutField = await buildExternalMessageBoc(baseInput());

    expect(withEmpty).toBe(withoutField);
  });

  it("includes extra currencies in the BOC", async () => {
    const withExtra = await buildExternalMessageBoc(
      baseInput({
        messages: [
          {
            address: RECIPIENT_ADDRESS.toString(),
            amount: "100000000",
            extraCurrency: { "100": "1000", "239": "9876543210" },
          },
        ],
      }),
    );
    const withoutExtra = await buildExternalMessageBoc(baseInput());

    expect(withExtra).not.toBe(withoutExtra);
    expect(() => decodeExternalMessage(withExtra)).not.toThrow();
  });

  it("rejects non-numeric extraCurrency IDs", async () => {
    await expect(
      buildExternalMessageBoc(
        baseInput({
          messages: [
            {
              address: RECIPIENT_ADDRESS.toString(),
              amount: "100",
              extraCurrency: { "not-a-number": "1000" },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/extraCurrency id/);
  });

  it("rejects extraCurrency IDs outside the uint32 range", async () => {
    await expect(
      buildExternalMessageBoc(
        baseInput({
          messages: [
            {
              address: RECIPIENT_ADDRESS.toString(),
              amount: "100",
              // 2^32 = 4294967296, one above uint32 max
              extraCurrency: { "4294967296": "1000" },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/uint32 range/);
  });

  it("rejects negative extraCurrency amounts", async () => {
    await expect(
      buildExternalMessageBoc(
        baseInput({
          messages: [
            {
              address: RECIPIENT_ADDRESS.toString(),
              amount: "100",
              extraCurrency: { "100": "-500" },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/negative/);
  });
});
