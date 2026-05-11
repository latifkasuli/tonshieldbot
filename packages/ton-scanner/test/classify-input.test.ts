import { describe, expect, it } from "vitest";
import { classifyInput } from "../src/classify-input.ts";

describe("classifyInput", () => {
  it("classifies Telegram handles and lowercases the canonical handle field", () => {
    // Telegram usernames are case-insensitive at the API layer, and
    // canonicalInputHash already lowercases for dedup. Keeping the
    // `handle` field raw-case would have made consumers disagree with
    // the cache key in subtle ways.
    expect(classifyInput("@TONShieldBot")).toMatchObject({
      kind: "telegram_handle",
      handle: "@tonshieldbot",
    });
  });

  it("classifies TON Connect links", () => {
    const request = encodeURIComponent(
      JSON.stringify({
        manifestUrl: "https://example.com/tonconnect-manifest.json",
        items: [{ name: "ton_addr" }],
      }),
    );

    expect(classifyInput(`tc://?v=2&id=req_123&r=${request}&ret=none`)).toMatchObject({
      kind: "tonconnect_link",
      requestId: "req_123",
    });
  });

  it("classifies transaction JSON", () => {
    expect(classifyInput(JSON.stringify({ messages: [] }))).toMatchObject({
      kind: "transaction_json",
    });
  });
});
