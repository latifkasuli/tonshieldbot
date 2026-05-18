import { describe, expect, it } from "vitest";
import { createOwnershipCache, ownershipOrNull } from "../src/ownership-cache.ts";
import type { UsernameOwnershipResult } from "../src/username-lookup.ts";

const okResult = (suffix = "default"): UsernameOwnershipResult => ({
  status: "ok",
  ownership: {
    username: `user_${suffix}`,
    nftAddress: `EQ${suffix}`,
    currentOwnerAddress: null,
    lastTransferAt: null,
    previousOwnerAddress: null,
    observedAt: 1_700_000_000,
  },
});

describe("createOwnershipCache", () => {
  it("returns null on miss", () => {
    const cache = createOwnershipCache();
    expect(cache.get("unknown")).toBeNull();
  });

  it("stores and returns ok results within TTL", () => {
    const cache = createOwnershipCache({ ttlMs: 60_000, now: () => new Date(1_000_000) });
    cache.set("tonkeeper", okResult());
    expect(cache.get("tonkeeper")).not.toBeNull();
  });

  it("expires entries after TTL", () => {
    let nowMs = 1_000_000;
    const cache = createOwnershipCache({ ttlMs: 60_000, now: () => new Date(nowMs) });
    cache.set("tonkeeper", okResult());
    nowMs += 70_000;
    expect(cache.get("tonkeeper")).toBeNull();
  });

  it("caches not_found results too", () => {
    const cache = createOwnershipCache();
    cache.set("randoshandle", { status: "not_found", reason: "no_dns_record" });
    expect(cache.get("randoshandle")).toEqual({ status: "not_found", reason: "no_dns_record" });
  });

  it("does NOT cache failed results (so retries can recover)", () => {
    const cache = createOwnershipCache();
    cache.set("tonkeeper", {
      status: "failed",
      failure: { status: "rate_limited", httpStatus: 429 },
    });
    expect(cache.get("tonkeeper")).toBeNull();
  });

  it("does NOT cache disabled results", () => {
    const cache = createOwnershipCache();
    cache.set("tonkeeper", { status: "disabled" });
    expect(cache.get("tonkeeper")).toBeNull();
  });

  it("evicts LRU entry when at capacity", () => {
    const cache = createOwnershipCache({ maxEntries: 2 });
    cache.set("a", okResult("a"));
    cache.set("b", okResult("b"));
    // Access `a` to make it most-recently-used.
    cache.get("a");
    cache.set("c", okResult("c"));
    // `b` was LRU, should be evicted.
    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).not.toBeNull();
    expect(cache.get("c")).not.toBeNull();
  });
});

describe("ownershipOrNull", () => {
  it("unwraps an ok result", () => {
    const owned = ownershipOrNull(okResult());
    expect(owned?.nftAddress).toBe("EQdefault");
  });

  it("returns null for non-ok results", () => {
    expect(ownershipOrNull(null)).toBeNull();
    expect(ownershipOrNull({ status: "disabled" })).toBeNull();
    expect(ownershipOrNull({ status: "not_found", reason: "no_dns_record" })).toBeNull();
  });
});
