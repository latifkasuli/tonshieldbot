import { describe, expect, it } from "vitest";
import type {
  BocInput,
  GenericUrlInput,
  ManifestUrlInput,
  ScanInput,
  TelegramHandleInput,
  TelegramUrlInput,
  TonAddressInput,
  TonConnectLinkInput,
  TransactionJsonInput,
  UnknownInput,
} from "@tonshield/shared";
import { deserializeInput, serializeInput } from "../src/postgres/serialize.ts";

const roundTrip = (input: ScanInput): ScanInput => {
  const serialized = serializeInput(input);
  // Force a JSON round-trip to mirror what jsonb storage actually does.
  const stored: unknown = JSON.parse(JSON.stringify(serialized));
  return deserializeInput(stored);
};

describe("ScanInput serialize/deserialize round-trip", () => {
  it("round-trips a TON Connect link with URL fields rebuilt", () => {
    const input: TonConnectLinkInput = {
      kind: "tonconnect_link",
      raw: "tc://?...",
      normalized: "tc://?...",
      manifestUrl: new URL("https://example.com/m.json"),
      requestId: "req_1",
      returnStrategy: "back",
    };

    const result = roundTrip(input);

    expect(result.kind).toBe("tonconnect_link");
    if (result.kind === "tonconnect_link") {
      expect(result.manifestUrl).toBeInstanceOf(URL);
      expect(result.manifestUrl.toString()).toBe("https://example.com/m.json");
      expect(result.requestId).toBe("req_1");
      expect(result.returnStrategy).toBe("back");
    }
  });

  it("round-trips a Telegram handle", () => {
    const input: TelegramHandleInput = {
      kind: "telegram_handle",
      raw: "@TONShield",
      normalized: "@tonshield",
      handle: "@TONShield",
    };

    expect(roundTrip(input)).toEqual(input);
  });

  it("round-trips a Telegram URL preserving null handles", () => {
    const input: TelegramUrlInput = {
      kind: "telegram_url",
      raw: "https://t.me/x",
      normalized: "https://t.me/x",
      url: new URL("https://t.me/x"),
      handle: null,
    };

    const result = roundTrip(input);

    expect(result.kind).toBe("telegram_url");
    if (result.kind === "telegram_url") {
      expect(result.handle).toBeNull();
      expect(result.url.toString()).toBe("https://t.me/x");
    }
  });

  it("round-trips manifest_url and generic_url URLs", () => {
    const m: ManifestUrlInput = {
      kind: "manifest_url",
      raw: "https://x.com/m.json",
      normalized: "https://x.com/m.json",
      url: new URL("https://x.com/m.json"),
    };
    const g: GenericUrlInput = {
      kind: "generic_url",
      raw: "https://x.com/page",
      normalized: "https://x.com/page",
      url: new URL("https://x.com/page"),
    };

    expect((roundTrip(m) as ManifestUrlInput).url.toString()).toBe("https://x.com/m.json");
    expect((roundTrip(g) as GenericUrlInput).url.toString()).toBe("https://x.com/page");
  });

  it("round-trips ton_address, boc, and transaction_json", () => {
    const addr: TonAddressInput = {
      kind: "ton_address",
      raw: "EQ_abc",
      normalized: "EQ_abc",
      address: "EQ_abc",
    };
    const boc: BocInput = {
      kind: "boc",
      raw: "te6cckEBA",
      normalized: "te6cckEBA",
      boc: "te6cckEBA",
    };
    const tx: TransactionJsonInput = {
      kind: "transaction_json",
      raw: '{"messages":[]}',
      normalized: '{"messages":[]}',
      transaction: { messages: [{ address: "EQ", amount: "1" }] },
    };

    expect(roundTrip(addr)).toEqual(addr);
    expect(roundTrip(boc)).toEqual(boc);
    expect(roundTrip(tx)).toEqual(tx);
  });

  it("round-trips an unknown input including its reason", () => {
    const input: UnknownInput = {
      kind: "unknown",
      raw: "garbage",
      normalized: "garbage",
      reason: "unsupported_input_shape",
    };

    expect(roundTrip(input)).toEqual(input);
  });

  it("rejects stored data with a missing kind discriminator", () => {
    expect(() => deserializeInput({ raw: "x", normalized: "x" })).toThrow(/no kind discriminator/i);
  });

  it("rejects stored data where a URL field is not a parseable URL", () => {
    expect(() =>
      deserializeInput({
        kind: "manifest_url",
        raw: "x",
        normalized: "x",
        url: "not a url",
      }),
    ).toThrow(/not a valid URL/i);
  });

  it("rejects stored data where a Telegram handle does not start with @", () => {
    expect(() =>
      deserializeInput({
        kind: "telegram_handle",
        raw: "x",
        normalized: "x",
        handle: "missingPrefix",
      }),
    ).toThrow(/does not start with @/i);
  });
});
