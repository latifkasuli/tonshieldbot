import { describe, expect, it } from "vitest";
// Import from the module directly rather than the package barrel: the barrel
// transitively loads `safe-fetch` (and thus `undici`), which breaks under the
// undici 8.2.0 module-init regression. Direct imports keep this suite isolated.
import { classifyInput } from "../src/classify-input.ts";

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
