import { describe, expect, it } from "vitest";
import { createInMemoryRateLimiter } from "../src/memory.ts";
import type { TierLimit } from "../src/tiers.ts";

const limit = (overrides: Partial<TierLimit> = {}): TierLimit => ({
  bucketSize: 10,
  refillPerSecond: 1,
  ...overrides,
});

describe("createInMemoryRateLimiter", () => {
  it("starts with a full bucket and allows the first cost-1 request", async () => {
    const rl = createInMemoryRateLimiter();

    const decision = await rl.check({ key: "k", limit: limit(), cost: 1, now: 1_000 });

    expect(decision).toMatchObject({ allowed: true, remaining: 9 });
  });

  it("denies a request that would overdraw the bucket and reports retryAfterMs", async () => {
    const rl = createInMemoryRateLimiter();

    // Drain the bucket.
    for (let i = 0; i < 10; i += 1) {
      await rl.check({ key: "k", limit: limit(), cost: 1, now: 1_000 });
    }

    const denied = await rl.check({ key: "k", limit: limit(), cost: 1, now: 1_000 });

    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      // 1 token at 1 token/sec = 1000ms wait.
      expect(denied.retryAfterMs).toBe(1000);
    }
  });

  it("refills the bucket linearly over time", async () => {
    const rl = createInMemoryRateLimiter();
    const l = limit({ bucketSize: 4, refillPerSecond: 2 });

    // Drain to 0.
    for (let i = 0; i < 4; i += 1) {
      await rl.check({ key: "k", limit: l, cost: 1, now: 0 });
    }
    const empty = await rl.check({ key: "k", limit: l, cost: 1, now: 0 });
    expect(empty.allowed).toBe(false);

    // 1 second later: 2 tokens refilled.
    const refilled = await rl.check({ key: "k", limit: l, cost: 1, now: 1_000 });
    expect(refilled).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("caps refill at the bucket size", async () => {
    const rl = createInMemoryRateLimiter();
    const l = limit({ bucketSize: 5, refillPerSecond: 1 });

    // First call to populate state.
    await rl.check({ key: "k", limit: l, cost: 1, now: 0 });

    // Wait an hour. Bucket should be full again, not 3604 tokens.
    const decision = await rl.check({ key: "k", limit: l, cost: 1, now: 60 * 60 * 1000 });

    expect(decision).toMatchObject({ allowed: true, remaining: 4 });
  });

  it("respects per-key isolation", async () => {
    const rl = createInMemoryRateLimiter();
    const l = limit({ bucketSize: 1, refillPerSecond: 1 });

    await rl.check({ key: "a", limit: l, cost: 1, now: 0 });
    const aSecond = await rl.check({ key: "a", limit: l, cost: 1, now: 0 });
    const bFirst = await rl.check({ key: "b", limit: l, cost: 1, now: 0 });

    expect(aSecond.allowed).toBe(false);
    expect(bFirst.allowed).toBe(true);
  });

  it("supports cost greater than 1 and denies when the cost exceeds available tokens", async () => {
    const rl = createInMemoryRateLimiter();
    const l = limit({ bucketSize: 5, refillPerSecond: 1 });

    const big = await rl.check({ key: "k", limit: l, cost: 5, now: 0 });
    expect(big).toMatchObject({ allowed: true, remaining: 0 });

    const tooBig = await rl.check({ key: "k", limit: l, cost: 5, now: 1_000 });
    expect(tooBig.allowed).toBe(false);
    if (!tooBig.allowed) {
      // 4 tokens missing at 1/sec = 4000ms.
      expect(tooBig.retryAfterMs).toBe(4000);
    }
  });

  it("does not consume tokens when denying", async () => {
    const rl = createInMemoryRateLimiter();
    const l = limit({ bucketSize: 2, refillPerSecond: 1 });

    await rl.check({ key: "k", limit: l, cost: 1, now: 0 });
    await rl.check({ key: "k", limit: l, cost: 1, now: 0 });

    // Bucket has 0 tokens. A cost-3 attempt is denied; the next 1-second
    // refill should restore 1 token, not subtract anything.
    await rl.check({ key: "k", limit: l, cost: 3, now: 0 });
    const oneSecondLater = await rl.check({ key: "k", limit: l, cost: 1, now: 1_000 });

    expect(oneSecondLater).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("reports a fullRefillAt that equals now when the bucket is full", async () => {
    const rl = createInMemoryRateLimiter();

    const decision = await rl.check({
      key: "k",
      limit: limit({ bucketSize: 10, refillPerSecond: 1 }),
      cost: 0,
      now: 5_000,
    });

    expect(decision).toMatchObject({ allowed: true, fullRefillAt: 5_000 });
  });
});
