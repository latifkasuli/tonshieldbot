import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlFetchCache } from "../src/cache.ts";
import type { CachedFetch } from "../src/types.ts";

const buildCachedFetch = (now: number, marker = "value"): CachedFetch => ({
  cachedAt: now,
  success: {
    body: `{"marker":"${marker}"}`,
    contentType: "application/json",
    finalUrl: new URL(`https://example.com/${marker}`),
  },
});

describe("TtlFetchCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined for a missing key", () => {
    const cache = new TtlFetchCache();

    expect(cache.get("https://example.com/missing")).toBeUndefined();
  });

  it("returns a cached entry within the TTL window", () => {
    const cache = new TtlFetchCache({ ttlMs: 60_000 });
    const entry = buildCachedFetch(Date.now());

    cache.set("https://example.com/a", entry);
    vi.advanceTimersByTime(30_000);

    expect(cache.get("https://example.com/a")).toEqual(entry);
  });

  it("evicts entries that have exceeded the TTL", () => {
    const cache = new TtlFetchCache({ ttlMs: 60_000 });
    const entry = buildCachedFetch(Date.now());

    cache.set("https://example.com/a", entry);
    vi.advanceTimersByTime(60_001);

    expect(cache.get("https://example.com/a")).toBeUndefined();
  });

  it("evicts the oldest entry when maxSize is reached", () => {
    const cache = new TtlFetchCache({ maxSize: 2, ttlMs: 60_000 });

    cache.set("https://example.com/a", buildCachedFetch(Date.now(), "a"));
    cache.set("https://example.com/b", buildCachedFetch(Date.now(), "b"));
    cache.set("https://example.com/c", buildCachedFetch(Date.now(), "c"));

    expect(cache.get("https://example.com/a")).toBeUndefined();
    expect(cache.get("https://example.com/b")?.success.body).toContain("b");
    expect(cache.get("https://example.com/c")?.success.body).toContain("c");
  });

  it("uses default TTL and maxSize when none are provided", () => {
    const cache = new TtlFetchCache();
    const entry = buildCachedFetch(Date.now());

    cache.set("https://example.com/a", entry);
    vi.advanceTimersByTime(59_999);
    expect(cache.get("https://example.com/a")).toEqual(entry);

    vi.advanceTimersByTime(2);
    expect(cache.get("https://example.com/a")).toBeUndefined();
  });
});
