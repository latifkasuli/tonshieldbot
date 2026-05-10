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

const bocInput = (): ScanInput => ({
  kind: "boc",
  raw: "te6ccgEBAQ",
  normalized: "te6ccgEBAQ",
  boc: "te6ccgEBAQ",
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

  it("returns true for boc when emulator is disabled (no live state to invalidate)", () => {
    expect(isScanResultCacheable(bocInput(), { emulatorEnabled: false })).toBe(true);
  });

  it("returns false for boc when emulator is enabled (state-dependent)", () => {
    // Raw BOC inputs go through `/v2/events/emulate` against current
    // blockchain state. Same reasoning as transaction_json: caching the
    // first emulation result would serve stale data, and pre-key cached
    // `EMULATION_NOT_CONFIGURED` findings would persist after key rollout.
    expect(isScanResultCacheable(bocInput(), { emulatorEnabled: true })).toBe(false);
  });

  // M3 PR-2: cache bypass for Telegram-shaped inputs when intel is on.

  const telegramHandleInput = (): ScanInput => ({
    kind: "telegram_handle",
    raw: "@somehandle",
    normalized: "@somehandle",
    handle: "@somehandle",
  });

  const telegramUrlInput = (): ScanInput => ({
    kind: "telegram_url",
    raw: "https://t.me/somechannel",
    normalized: "https://t.me/somechannel",
    url: new URL("https://t.me/somechannel"),
    handle: "somechannel",
  });

  const telegramDeeplinkInput = (): ScanInput => ({
    kind: "telegram_deeplink",
    raw: "https://t.me/somebot?startapp=foo",
    normalized: "https://t.me/somebot?startapp=foo",
    url: new URL("https://t.me/somebot?startapp=foo"),
    action: "startapp",
    target: "somebot",
    appShortName: null,
    payload: "foo",
  });

  it("returns true for telegram_handle when telegramIntelEnabled is false (no live state to invalidate)", () => {
    expect(
      isScanResultCacheable(telegramHandleInput(), {
        emulatorEnabled: false,
        telegramIntelEnabled: false,
      }),
    ).toBe(true);
  });

  it("returns false for telegram_handle when telegramIntelEnabled is true (state-dependent)", () => {
    expect(
      isScanResultCacheable(telegramHandleInput(), {
        emulatorEnabled: false,
        telegramIntelEnabled: true,
      }),
    ).toBe(false);
  });

  it("returns false for telegram_url and telegram_deeplink when telegramIntelEnabled is true", () => {
    expect(
      isScanResultCacheable(telegramUrlInput(), {
        emulatorEnabled: false,
        telegramIntelEnabled: true,
      }),
    ).toBe(false);
    expect(
      isScanResultCacheable(telegramDeeplinkInput(), {
        emulatorEnabled: false,
        telegramIntelEnabled: true,
      }),
    ).toBe(false);
  });

  it("defaults telegramIntelEnabled to undefined (treated as false) when omitted", () => {
    expect(isScanResultCacheable(telegramHandleInput(), { emulatorEnabled: false })).toBe(true);
  });

  it("returns true for unknown inputs regardless of emulator state", () => {
    expect(isScanResultCacheable(unknownInput(), { emulatorEnabled: false })).toBe(true);
    expect(isScanResultCacheable(unknownInput(), { emulatorEnabled: true })).toBe(true);
  });
});
