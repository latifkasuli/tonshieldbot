import { describe, expect, it } from "vitest";
import type {
  BocInput,
  GenericUrlInput,
  ManifestUrlInput,
  TelegramDeeplinkInput,
  TelegramHandleInput,
  TelegramUrlInput,
  TonAddressInput,
  TonConnectLinkInput,
  TransactionJsonInput,
  UnknownInput,
} from "@tonshield/shared";
import { canonicalInputHash } from "../src/canonical-hash.ts";

const tonConnectLink = (overrides: Partial<TonConnectLinkInput> = {}): TonConnectLinkInput => ({
  kind: "tonconnect_link",
  raw: "tc://?v=2&id=req_1&r=...",
  normalized: "tc://?v=2&id=req_1&r=...",
  manifestUrl: new URL("https://example.com/tonconnect-manifest.json"),
  requestId: "req_1",
  returnStrategy: "none",
  ...overrides,
});

const transactionJson = (transaction: Readonly<Record<string, unknown>>): TransactionJsonInput => ({
  kind: "transaction_json",
  raw: JSON.stringify(transaction),
  normalized: JSON.stringify(transaction),
  transaction,
});

describe("canonicalInputHash", () => {
  it("produces a stable 64-char hex SHA-256 digest", () => {
    const hash = canonicalInputHash(tonConnectLink());

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── golden values ────────────────────────────────────────────────────────
  // Fix exact hex output for known inputs. Any change to canonicalization
  // logic that breaks dedup will fail these immediately. Update deliberately.

  it("hashes a TON Connect link to a fixed golden value", () => {
    expect(canonicalInputHash(tonConnectLink())).toBe(
      "3aa7dd87fdc620f2bf946e22bed7f8c05ef7023ef0be70ec6d4b5c412e822115",
    );
  });

  it("hashes a Telegram handle to a fixed golden value", () => {
    const input: TelegramHandleInput = {
      kind: "telegram_handle",
      raw: "@TONShieldBot",
      normalized: "@tonshieldbot",
      handle: "@TONShieldBot",
    };

    expect(canonicalInputHash(input)).toBe(
      "567cd3003c657a7b3547fb9be801038cfe8686159f1397f67f9d4681e5f23ff2",
    );
  });

  // ── dedup semantics ──────────────────────────────────────────────────────

  it("dedupes TON Connect links that differ only in requestId", () => {
    const a = canonicalInputHash(tonConnectLink({ requestId: "req_a" }));
    const b = canonicalInputHash(tonConnectLink({ requestId: "req_b" }));

    expect(a).toBe(b);
  });

  it("dedupes TON Connect links that differ only in returnStrategy", () => {
    const a = canonicalInputHash(tonConnectLink({ returnStrategy: "none" }));
    const b = canonicalInputHash(tonConnectLink({ returnStrategy: "back" }));

    expect(a).toBe(b);
  });

  it("does not dedupe TON Connect links pointing to different manifests", () => {
    const a = canonicalInputHash(
      tonConnectLink({ manifestUrl: new URL("https://a.example/m.json") }),
    );
    const b = canonicalInputHash(
      tonConnectLink({ manifestUrl: new URL("https://b.example/m.json") }),
    );

    expect(a).not.toBe(b);
  });

  it("dedupes Telegram handles regardless of casing", () => {
    const upper: TelegramHandleInput = {
      kind: "telegram_handle",
      raw: "@TONShield",
      normalized: "@tonshield",
      handle: "@TONShield",
    };
    const lower: TelegramHandleInput = { ...upper, handle: "@tonshield" };

    expect(canonicalInputHash(upper)).toBe(canonicalInputHash(lower));
  });

  it("does not dedupe Telegram deeplinks that differ only in extras", () => {
    const base: TelegramDeeplinkInput = {
      kind: "telegram_deeplink",
      raw: "https://t.me/somebot?startapp=foo&mode=fullscreen",
      normalized: "https://t.me/somebot?startapp=foo&mode=fullscreen",
      url: new URL("https://t.me/somebot?startapp=foo&mode=fullscreen"),
      action: "startapp",
      target: "somebot",
      appShortName: null,
      payload: "foo",
      extras: { mode: "fullscreen" },
    };
    const compact = { ...base, extras: { mode: "compact" } };

    expect(canonicalInputHash(base)).not.toBe(canonicalInputHash(compact));
  });

  it("dedupes transaction JSON regardless of key ordering", () => {
    const a = transactionJson({ messages: [{ address: "EQ...", amount: "100" }] });
    const b = transactionJson({ messages: [{ amount: "100", address: "EQ..." }] });

    expect(canonicalInputHash(a)).toBe(canonicalInputHash(b));
  });

  it("does not dedupe transaction JSON that differs in array order", () => {
    // Order is semantic in TON Connect message lists — different order means
    // different transaction even with the same elements.
    const a = transactionJson({
      messages: [
        { address: "EQ_A", amount: "1" },
        { address: "EQ_B", amount: "2" },
      ],
    });
    const b = transactionJson({
      messages: [
        { address: "EQ_B", amount: "2" },
        { address: "EQ_A", amount: "1" },
      ],
    });

    expect(canonicalInputHash(a)).not.toBe(canonicalInputHash(b));
  });

  it("dedupes TON addresses regardless of surrounding whitespace and case", () => {
    const trimmed: TonAddressInput = {
      kind: "ton_address",
      raw: "  EQ_abc  ",
      normalized: "EQ_abc",
      address: "EQ_abc",
    };
    const messy: TonAddressInput = {
      ...trimmed,
      address: "  eq_abc  ",
    };

    expect(canonicalInputHash(trimmed)).toBe(canonicalInputHash(messy));
  });

  it("dedupes BOCs regardless of surrounding whitespace", () => {
    const a: BocInput = {
      kind: "boc",
      raw: " te6cckEBA... ",
      normalized: "te6cckEBA...",
      boc: "te6cckEBA...",
    };
    const b: BocInput = { ...a, boc: "  te6cckEBA...  " };

    expect(canonicalInputHash(a)).toBe(canonicalInputHash(b));
  });

  it("hashes different ScanInput kinds to distinct values even with similar content", () => {
    const url = new URL("https://example.com/m.json");
    const manifest: ManifestUrlInput = {
      kind: "manifest_url",
      raw: url.toString(),
      normalized: url.toString(),
      url,
    };
    const generic: GenericUrlInput = {
      kind: "generic_url",
      raw: url.toString(),
      normalized: url.toString(),
      url,
    };
    const telegram: TelegramUrlInput = {
      kind: "telegram_url",
      raw: url.toString(),
      normalized: url.toString(),
      url,
      handle: null,
    };

    const hashes = new Set([
      canonicalInputHash(manifest),
      canonicalInputHash(generic),
      canonicalInputHash(telegram),
    ]);

    expect(hashes.size).toBe(3);
  });

  it("dedupes unknown inputs by normalized content, not by reason", () => {
    const a: UnknownInput = {
      kind: "unknown",
      raw: "garbage",
      normalized: "garbage",
      reason: "unsupported_input_shape",
    };
    const b: UnknownInput = { ...a, reason: "empty_input" };

    expect(canonicalInputHash(a)).toBe(canonicalInputHash(b));
  });

  it("rejects non-JSON values inside transaction_json with a descriptive error", () => {
    // Build the input directly: the `transactionJson` helper would fail on
    // `JSON.stringify` first, but we want to exercise the canonicalizer's
    // own rejection path.
    const input: TransactionJsonInput = {
      kind: "transaction_json",
      raw: "<unserializable>",
      normalized: "<unserializable>",
      transaction: { messages: [{ address: "EQ...", amount: 1n }] },
    };

    expect(() => canonicalInputHash(input)).toThrow(/cannot canonicalize value of type bigint/i);
  });
});
