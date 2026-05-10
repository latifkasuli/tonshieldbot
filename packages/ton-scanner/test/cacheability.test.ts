import { describe, expect, it } from "vitest";
import type { ScanInput } from "@tonshield/shared";
import { isScanResultCacheable } from "../src/cacheability.ts";

const transactionInput = (): ScanInput => ({
  kind: "transaction_json",
  raw: "{}",
  normalized: "{}",
  transaction: {},
});

const tonAddressInput = (): ScanInput => ({
  kind: "ton_address",
  raw: "EQA",
  normalized: "EQA",
  address: "EQA",
});

const unknownInput = (): ScanInput => ({
  kind: "unknown",
  raw: "garbage",
  normalized: "garbage",
  reason: "did not match",
});

describe("isScanResultCacheable", () => {
  it("returns true for transaction_json when emulator is disabled (static-only is deterministic)", () => {
    expect(isScanResultCacheable(transactionInput(), { emulatorEnabled: false })).toBe(true);
  });

  it("returns false for transaction_json when emulator is enabled (state-dependent)", () => {
    // This is the central guarantee: a transaction scanned before TONAPI_KEY
    // was set leaves an `EMULATION_NOT_CONFIGURED` finding in cache. Without
    // this rule, enabling the key wouldn't trigger a re-scan and that
    // finding would be served forever.
    expect(isScanResultCacheable(transactionInput(), { emulatorEnabled: true })).toBe(false);
  });

  it("returns true for ton_address regardless of emulator state", () => {
    expect(isScanResultCacheable(tonAddressInput(), { emulatorEnabled: false })).toBe(true);
    expect(isScanResultCacheable(tonAddressInput(), { emulatorEnabled: true })).toBe(true);
  });

  it("returns true for unknown inputs regardless of emulator state", () => {
    expect(isScanResultCacheable(unknownInput(), { emulatorEnabled: false })).toBe(true);
    expect(isScanResultCacheable(unknownInput(), { emulatorEnabled: true })).toBe(true);
  });
});
