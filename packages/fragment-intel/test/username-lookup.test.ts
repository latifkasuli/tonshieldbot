import { describe, expect, it, vi } from "vitest";
import type { FragmentIntelClient } from "../src/client.ts";
import { lookupUsernameOwnership } from "../src/username-lookup.ts";

const stubAddress = (value: string) => ({ toString: () => value });

interface MockHistoryEvent {
  timestamp: number;
  actions: {
    type: string;
    NftItemTransfer?: { sender?: { address: { toString: () => string } } };
  }[];
}

const makeClient = (
  api: {
    getDnsInfo?: ReturnType<typeof vi.fn>;
    getNftHistoryById?: ReturnType<typeof vi.fn>;
  },
  enabled = true,
): FragmentIntelClient => ({
  enabled,
  baseUrl: "https://tonapi.io",
  raw: {
    dns: { getDnsInfo: api.getDnsInfo ?? vi.fn() },
    nft: { getNftHistoryById: api.getNftHistoryById ?? vi.fn() },
  } as unknown as FragmentIntelClient["raw"],
});

describe("lookupUsernameOwnership — disabled / shape checks", () => {
  it("returns disabled when the client has no token", async () => {
    const result = await lookupUsernameOwnership(makeClient({}, false), "tonkeeper");
    expect(result.status).toBe("disabled");
  });

  it("returns not_found for inputs that don't look like Telegram usernames", async () => {
    const dns = vi.fn();
    const result = await lookupUsernameOwnership(makeClient({ getDnsInfo: dns }), "??!!");
    expect(result.status).toBe("not_found");
    expect(dns).not.toHaveBeenCalled();
  });

  it("lowercases + strips `@` from candidate before DNS lookup", async () => {
    const dns = vi.fn().mockResolvedValue({ item: undefined });
    await lookupUsernameOwnership(makeClient({ getDnsInfo: dns }), "@Tonkeeper");
    expect(dns).toHaveBeenCalledWith("tonkeeper.t.me");
  });
});

describe("lookupUsernameOwnership — success paths", () => {
  it("returns ok with lastTransferAt from the most recent NftItemTransfer", async () => {
    const dns = vi.fn().mockResolvedValue({
      item: {
        address: stubAddress("EQNftAddrXYZ"),
        owner: { address: stubAddress("EQCurrentOwner") },
      },
    });

    const events: MockHistoryEvent[] = [
      {
        timestamp: 1_700_000_000,
        actions: [
          {
            type: "NftItemTransfer",
            NftItemTransfer: { sender: { address: stubAddress("EQPrevOwner") } },
          },
        ],
      },
      {
        // Older transfer — should be ignored once we found the newer one.
        timestamp: 1_600_000_000,
        actions: [
          {
            type: "NftItemTransfer",
            NftItemTransfer: { sender: { address: stubAddress("EQAncient") } },
          },
        ],
      },
    ];
    const history = vi.fn().mockResolvedValue({ events, nextFrom: 0 });

    const result = await lookupUsernameOwnership(
      makeClient({ getDnsInfo: dns, getNftHistoryById: history }),
      "tonkeeper",
      { now: () => new Date(1_700_000_000_000 + 5 * 24 * 60 * 60 * 1000) },
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.ownership.nftAddress).toBe("EQNftAddrXYZ");
    expect(result.ownership.currentOwnerAddress).toBe("EQCurrentOwner");
    expect(result.ownership.lastTransferAt).toBe(1_700_000_000);
    expect(result.ownership.previousOwnerAddress).toBe("EQPrevOwner");
  });

  it("returns ok with null lastTransferAt when no NftItemTransfer is in the recent history", async () => {
    const dns = vi.fn().mockResolvedValue({
      item: { address: stubAddress("EQNft"), owner: { address: stubAddress("EQOwner") } },
    });
    const history = vi.fn().mockResolvedValue({
      events: [{ timestamp: 1_700_000_000, actions: [{ type: "DomainRenew" }] }],
      nextFrom: 0,
    });

    const result = await lookupUsernameOwnership(
      makeClient({ getDnsInfo: dns, getNftHistoryById: history }),
      "tonkeeper",
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.ownership.lastTransferAt).toBeNull();
    expect(result.ownership.previousOwnerAddress).toBeNull();
  });
});

describe("lookupUsernameOwnership — not_found paths", () => {
  it("returns not_found:no_nft_item when DNS resolves but the record has no item", async () => {
    const dns = vi.fn().mockResolvedValue({ item: undefined });
    const result = await lookupUsernameOwnership(makeClient({ getDnsInfo: dns }), "tonkeeper");
    expect(result.status).toBe("not_found");
    if (result.status !== "not_found") return;
    expect(result.reason).toBe("no_nft_item");
  });

  it("returns not_found:no_dns_record when TONAPI returns 404 for the domain", async () => {
    const dns = vi.fn().mockRejectedValue({ status: 404 });
    const result = await lookupUsernameOwnership(makeClient({ getDnsInfo: dns }), "tonkeeper");
    expect(result.status).toBe("not_found");
    if (result.status !== "not_found") return;
    expect(result.reason).toBe("no_dns_record");
  });
});

describe("lookupUsernameOwnership — TONAPI failures", () => {
  it("returns failed with rate_limited classification on 429", async () => {
    const dns = vi.fn().mockRejectedValue({ status: 429 });
    const result = await lookupUsernameOwnership(makeClient({ getDnsInfo: dns }), "tonkeeper");
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.status).toBe("rate_limited");
  });

  it("returns failed with provider_down classification on network error (no status)", async () => {
    const dns = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const result = await lookupUsernameOwnership(makeClient({ getDnsInfo: dns }), "tonkeeper");
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.status).toBe("provider_down");
  });

  it("returns ok with null lastTransferAt when history endpoint returns 404", async () => {
    const dns = vi.fn().mockResolvedValue({
      item: { address: stubAddress("EQNft"), owner: { address: stubAddress("EQOwner") } },
    });
    const history = vi.fn().mockRejectedValue({ status: 404 });

    const result = await lookupUsernameOwnership(
      makeClient({ getDnsInfo: dns, getNftHistoryById: history }),
      "tonkeeper",
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.ownership.lastTransferAt).toBeNull();
  });
});
