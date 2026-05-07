import { describe, expect, it } from "vitest";
import { classifyInput } from "../src/index.ts";

describe("classifyInput", () => {
  it("classifies Telegram handles", () => {
    expect(classifyInput("@TONShieldBot")).toMatchObject({
      kind: "telegram_handle",
      handle: "@TONShieldBot",
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
