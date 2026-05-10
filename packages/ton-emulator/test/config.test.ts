import { describe, expect, it } from "vitest";
import { isEmulationEnabled, loadTonEmulatorConfig } from "../src/config.ts";
import { createTonEmulatorClient } from "../src/client.ts";

describe("loadTonEmulatorConfig", () => {
  it("treats a missing TONAPI_KEY as disabled (not an error)", () => {
    const config = loadTonEmulatorConfig({});

    expect(config.apiKey).toBeNull();
    expect(isEmulationEnabled(config)).toBe(false);
  });

  it("defaults base URL to https://tonapi.io when not set", () => {
    const config = loadTonEmulatorConfig({});

    expect(config.baseUrl).toBe("https://tonapi.io");
  });

  it("honours TONAPI_KEY and TONAPI_BASE_URL when both are set", () => {
    const config = loadTonEmulatorConfig({
      TONAPI_KEY: "test-key",
      TONAPI_BASE_URL: "https://testnet.tonapi.io",
    });

    expect(config.apiKey).toBe("test-key");
    expect(config.baseUrl).toBe("https://testnet.tonapi.io");
    expect(isEmulationEnabled(config)).toBe(true);
  });

  it("rejects a malformed TONAPI_BASE_URL via zod", () => {
    expect(() => loadTonEmulatorConfig({ TONAPI_BASE_URL: "not-a-url" })).toThrow();
  });
});

describe("createTonEmulatorClient", () => {
  it("returns enabled=false when no key was provided", () => {
    const client = createTonEmulatorClient({ apiKey: null, baseUrl: "https://tonapi.io" });

    expect(client.enabled).toBe(false);
    expect(client.baseUrl).toBe("https://tonapi.io");
  });

  it("returns enabled=true when a key is provided", () => {
    const client = createTonEmulatorClient({
      apiKey: "test-key",
      baseUrl: "https://tonapi.io",
    });

    expect(client.enabled).toBe(true);
  });
});
