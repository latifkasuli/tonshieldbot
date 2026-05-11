import { describe, expect, it, vi } from "vitest";
import type { TelegramIntelClient } from "../src/client.ts";
import { resolveById, resolveChannelOrSupergroup } from "../src/entity-resolver.ts";

const clientWithGetChat = (getChat: ReturnType<typeof vi.fn>): TelegramIntelClient => ({
  enabled: true,
  apiBaseUrl: "https://api.telegram.org",
  raw: { getChat } as unknown as TelegramIntelClient["raw"],
});

describe("entity resolver", () => {
  it("returns a specific reason when a handle resolves but is not a channel/supergroup", async () => {
    const client = clientWithGetChat(
      vi.fn().mockResolvedValue({
        id: -123,
        type: "group",
        title: "Small Group",
      }),
    );

    const result = await resolveChannelOrSupergroup(client, "smallgroup");

    expect(result).toMatchObject({
      status: "not_resolvable",
      reason: "resolved_not_channel_or_supergroup",
    });
  });

  it("uses a string chat id and maps ID lookup misses to entity_not_found_by_id", async () => {
    const getChat = vi.fn().mockRejectedValue({
      error_code: 400,
      description: "Bad Request: chat not found",
    });
    const client = clientWithGetChat(getChat);

    const result = await resolveById(client, 9_007_199_254_740_991n);

    expect(getChat).toHaveBeenCalledWith("9007199254740991");
    expect(result).toMatchObject({
      status: "not_resolvable",
      reason: "entity_not_found_by_id",
    });
  });
});
