import { describe, expect, it } from "vitest";
import { createTelegramIntelClient } from "../src/client.ts";
import { isTelegramIntelEnabled, loadTelegramIntelConfig } from "../src/config.ts";

describe("loadTelegramIntelConfig", () => {
  it("treats a missing TELEGRAM_INTEL_BOT_TOKEN as disabled (not an error)", () => {
    const config = loadTelegramIntelConfig({});

    expect(config.token).toBeNull();
    expect(isTelegramIntelEnabled(config)).toBe(false);
  });

  it("defaults base URL to https://api.telegram.org when not set", () => {
    const config = loadTelegramIntelConfig({});

    expect(config.apiBaseUrl).toBe("https://api.telegram.org");
  });

  it("honours TELEGRAM_INTEL_BOT_TOKEN and TELEGRAM_API_BASE_URL when both are set", () => {
    const config = loadTelegramIntelConfig({
      TELEGRAM_INTEL_BOT_TOKEN: "123456:ABCDEF",
      TELEGRAM_API_BASE_URL: "https://api.example.com",
    });

    expect(config.token).toBe("123456:ABCDEF");
    expect(config.apiBaseUrl).toBe("https://api.example.com");
    expect(isTelegramIntelEnabled(config)).toBe(true);
  });

  it("rejects a malformed TELEGRAM_API_BASE_URL via zod", () => {
    expect(() => loadTelegramIntelConfig({ TELEGRAM_API_BASE_URL: "not-a-url" })).toThrow();
  });

  it("rejects an empty TELEGRAM_INTEL_BOT_TOKEN via zod (empty string is not a valid token)", () => {
    // An empty string would let grammY construct an `Api` that "looks
    // configured" but every call would 401. Better to treat empty as
    // misconfigured at load time and force the operator to fix it.
    expect(() => loadTelegramIntelConfig({ TELEGRAM_INTEL_BOT_TOKEN: "" })).toThrow();
  });
});

describe("createTelegramIntelClient", () => {
  it("returns enabled=false when no token was provided", () => {
    const client = createTelegramIntelClient({
      token: null,
      apiBaseUrl: "https://api.telegram.org",
    });

    expect(client.enabled).toBe(false);
    expect(client.apiBaseUrl).toBe("https://api.telegram.org");
  });

  it("returns enabled=true when a token is provided", () => {
    const client = createTelegramIntelClient({
      token: "123456:ABCDEF",
      apiBaseUrl: "https://api.telegram.org",
    });

    expect(client.enabled).toBe(true);
  });

  it("constructs a grammY Api instance in both enabled and disabled states", () => {
    // The Api instance is always present so downstream code can pass it
    // around without null-handling. The `enabled` flag is the contract for
    // whether to actually call into it. This test guards against a future
    // refactor that might lazily-construct the Api and break callers.
    const enabledClient = createTelegramIntelClient({
      token: "1:t",
      apiBaseUrl: "https://api.telegram.org",
    });
    const disabledClient = createTelegramIntelClient({
      token: null,
      apiBaseUrl: "https://api.telegram.org",
    });

    expect(enabledClient.raw).toBeDefined();
    expect(disabledClient.raw).toBeDefined();
  });
});
