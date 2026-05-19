import { describe, expect, it, vi } from "vitest";
import type { TelegramIntelClient } from "../src/client.ts";
import { resolveById, resolveChannelOrSupergroup } from "../src/entity-resolver.ts";

const clientWithGetChat = (getChat: ReturnType<typeof vi.fn>): TelegramIntelClient => ({
  enabled: true,
  apiBaseUrl: "https://api.telegram.org",
  raw: { getChat } as unknown as TelegramIntelClient["raw"],
});

describe("entity resolver", () => {
  it("accepts public user/bot handles when getChat returns a private chat", async () => {
    const client = clientWithGetChat(
      vi.fn().mockResolvedValue({
        id: 123456789,
        type: "private",
        username: "starhashrobot",
        first_name: "Star Hash",
        is_bot: true,
      }),
    );

    const result = await resolveChannelOrSupergroup(client, "starhashrobot");

    expect(result).toMatchObject({
      status: "ok",
      entity: {
        id: 123456789n,
        kind: "bot",
        username: "starhashrobot",
        displayName: "Star Hash",
        isBot: true,
      },
    });
  });

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
