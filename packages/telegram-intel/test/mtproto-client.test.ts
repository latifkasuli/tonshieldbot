import { describe, expect, it } from "vitest";
import { createMtprotoIntelClient } from "../src/mtproto-client.ts";

describe("createMtprotoIntelClient", () => {
  it("is disabled when api credentials or auth material are missing", async () => {
    const client = createMtprotoIntelClient({
      apiId: null,
      apiHash: null,
      botToken: null,
      session: null,
    });

    expect(client.enabled).toBe(false);
    expect(client.authMode).toBe("disabled");
    await expect(client.resolveUsername("@telegram")).resolves.toEqual({ status: "disabled" });
  });

  it("prefers session auth mode when both session and bot token are provided", () => {
    const client = createMtprotoIntelClient({
      apiId: 12345,
      apiHash: "hash",
      botToken: "123:token",
      session: "session",
    });

    expect(client.enabled).toBe(true);
    expect(client.authMode).toBe("session");
  });
});
