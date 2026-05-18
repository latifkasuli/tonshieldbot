import { describe, expect, it, vi } from "vitest";
import type { FragmentIntelClient } from "@tonshield/fragment-intel";
import { checkFragmentHandoff } from "../src/telegram/fragment-handoff.ts";

const stubAddress = (value: string) => ({ toString: () => value });

interface RawApi {
  dns: { getDnsInfo: ReturnType<typeof vi.fn> };
  nft: { getNftHistoryById: ReturnType<typeof vi.fn> };
}

const makeClient = (api: Partial<RawApi>, enabled = true): FragmentIntelClient => ({
  enabled,
  baseUrl: "https://tonapi.io",
  raw: {
    dns: api.dns ?? { getDnsInfo: vi.fn() },
    nft: api.nft ?? { getNftHistoryById: vi.fn() },
  } as unknown as FragmentIntelClient["raw"],
});

const NOW_MS = new Date("2026-05-18T00:00:00Z").getTime();
const recent = (daysAgo: number): number =>
  Math.floor((NOW_MS - daysAgo * 24 * 60 * 60 * 1000) / 1000);

const dnsResolvesTo = (sec: number, sender: string | null) => ({
  dns: {
    getDnsInfo: vi.fn().mockResolvedValue({
      item: {
        address: stubAddress("EQNftXYZ"),
        owner: { address: stubAddress("EQNew") },
      },
    }),
  },
  nft: {
    getNftHistoryById: vi.fn().mockResolvedValue({
      events: [
        {
          timestamp: sec,
          actions: [
            {
              type: "NftItemTransfer",
              ...(sender === null
                ? { NftItemTransfer: {} }
                : { NftItemTransfer: { sender: { address: stubAddress(sender) } } }),
            },
          ],
        },
      ],
      nextFrom: 0,
    }),
  },
});

describe("checkFragmentHandoff — health degradation", () => {
  it("emits TELEGRAM_FRAGMENT_API_NOT_CONFIGURED when no client is provided", async () => {
    const findings = await checkFragmentHandoff(undefined, "tonkeeper");
    expect(findings.map((f) => f.ruleId)).toEqual(["TELEGRAM_FRAGMENT_API_NOT_CONFIGURED"]);
  });

  it("emits TELEGRAM_FRAGMENT_API_NOT_CONFIGURED when the client is disabled", async () => {
    const findings = await checkFragmentHandoff(makeClient({}, false), "tonkeeper");
    expect(findings.map((f) => f.ruleId)).toEqual(["TELEGRAM_FRAGMENT_API_NOT_CONFIGURED"]);
  });

  it("emits TELEGRAM_FRAGMENT_API_UNAVAILABLE on TONAPI failure", async () => {
    const client = makeClient({
      dns: { getDnsInfo: vi.fn().mockRejectedValue({ status: 429 }) },
    });
    const findings = await checkFragmentHandoff(client, "tonkeeper");
    expect(findings.map((f) => f.ruleId)).toEqual(["TELEGRAM_FRAGMENT_API_UNAVAILABLE"]);
  });

  it("emits nothing for null / empty / non-username inputs", async () => {
    expect(await checkFragmentHandoff(undefined, null)).toEqual([]);
    expect(await checkFragmentHandoff(undefined, "")).toEqual([]);
    expect(await checkFragmentHandoff(undefined, "@")).toEqual([]);
  });
});

describe("checkFragmentHandoff — recent handoff detection", () => {
  it("fires TELEGRAM_USERNAME_FRAGMENT_HANDOFF when the most recent transfer is within the window", async () => {
    const client = makeClient(dnsResolvesTo(recent(10), "EQPrev"));
    const findings = await checkFragmentHandoff(client, "tonkeeper", {
      now: () => new Date(NOW_MS),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("TELEGRAM_USERNAME_FRAGMENT_HANDOFF");
    expect(findings[0]?.confidence).toBe("medium");
    expect(findings[0]?.evidence).toMatchObject({
      username: "tonkeeper",
      nftAddress: "EQNftXYZ",
      previousOwnerAddress: "EQPrev",
      ageDays: 10,
      recentWindowDays: 30,
    });
  });

  it("fires at HIGH confidence when the transfer is within 7 days", async () => {
    const client = makeClient(dnsResolvesTo(recent(3), "EQPrev"));
    const findings = await checkFragmentHandoff(client, "tonkeeper", {
      now: () => new Date(NOW_MS),
    });
    expect(findings[0]?.confidence).toBe("high");
  });

  it("does NOT fire when the most recent transfer is older than the window", async () => {
    const client = makeClient(dnsResolvesTo(recent(120), "EQPrev"));
    const findings = await checkFragmentHandoff(client, "tonkeeper", {
      now: () => new Date(NOW_MS),
    });
    expect(findings).toEqual([]);
  });

  it("does NOT fire on `not_found` (non-Fragment handle)", async () => {
    const client = makeClient({
      dns: { getDnsInfo: vi.fn().mockRejectedValue({ status: 404 }) },
    });
    const findings = await checkFragmentHandoff(client, "randoshandle");
    expect(findings).toEqual([]);
  });

  it("does NOT fire when last transfer is null (no transfers recorded)", async () => {
    const client = makeClient({
      dns: {
        getDnsInfo: vi.fn().mockResolvedValue({
          item: { address: stubAddress("EQNft"), owner: { address: stubAddress("EQOwner") } },
        }),
      },
      nft: {
        getNftHistoryById: vi.fn().mockResolvedValue({ events: [], nextFrom: 0 }),
      },
    });
    const findings = await checkFragmentHandoff(client, "tonkeeper");
    expect(findings).toEqual([]);
  });
});

describe("checkFragmentHandoff — cache integration", () => {
  it("reuses a cached lookup instead of re-issuing TONAPI calls", async () => {
    const dnsFn = vi.fn().mockResolvedValue({
      item: { address: stubAddress("EQNft"), owner: { address: stubAddress("EQOwner") } },
    });
    const historyFn = vi.fn().mockResolvedValue({
      events: [
        {
          timestamp: recent(5),
          actions: [
            {
              type: "NftItemTransfer",
              NftItemTransfer: { sender: { address: stubAddress("EQPrev") } },
            },
          ],
        },
      ],
      nextFrom: 0,
    });
    const client = makeClient({
      dns: { getDnsInfo: dnsFn },
      nft: { getNftHistoryById: historyFn },
    });

    const { createOwnershipCache } = await import("@tonshield/fragment-intel");
    const cache = createOwnershipCache();

    const first = await checkFragmentHandoff(client, "tonkeeper", {
      cache,
      now: () => new Date(NOW_MS),
    });
    const second = await checkFragmentHandoff(client, "tonkeeper", {
      cache,
      now: () => new Date(NOW_MS),
    });

    expect(first).toEqual(second);
    expect(dnsFn).toHaveBeenCalledTimes(1);
    expect(historyFn).toHaveBeenCalledTimes(1);
  });
});
