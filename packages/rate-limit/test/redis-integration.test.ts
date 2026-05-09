import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRedisRateLimiter } from "../src/redis.ts";
import type { TierLimit } from "../src/tiers.ts";

/**
 * Integration tests against a real Redis. Skipped unless `TEST_REDIS_URL`
 * is set. CI wires this up alongside the Postgres service.
 */
const redisUrl = process.env.TEST_REDIS_URL;

const limit = (overrides: Partial<TierLimit> = {}): TierLimit => ({
  bucketSize: 5,
  refillPerSecond: 1,
  ...overrides,
});

describe.skipIf(redisUrl === undefined || redisUrl.length === 0)("createRedisRateLimiter", () => {
  let redis: Redis | undefined;
  const requireRedis = (): Redis => {
    if (redis === undefined) {
      throw new Error("Redis client not initialized");
    }
    return redis;
  };

  beforeAll(() => {
    if (redisUrl === undefined) {
      return;
    }
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  });

  afterAll(async () => {
    await redis?.quit();
  });

  beforeEach(async () => {
    // Wipe only the rate-limit keys so tests don't trample anything else.
    const keys = await requireRedis().keys("rl:test:*");
    if (keys.length > 0) {
      await requireRedis().del(...keys);
    }
  });

  it("starts with a full bucket and decrements on use", async () => {
    const rl = createRedisRateLimiter({ redis: requireRedis(), keyPrefix: "rl:test:" });
    const l = limit();

    const first = await rl.check({ key: "k1", limit: l, cost: 1, now: 1_000 });

    expect(first).toMatchObject({ allowed: true, remaining: 4 });
  });

  it("denies once the bucket is drained and refills over time", async () => {
    const rl = createRedisRateLimiter({ redis: requireRedis(), keyPrefix: "rl:test:" });
    const l = limit();

    for (let i = 0; i < 5; i += 1) {
      await rl.check({ key: "k2", limit: l, cost: 1, now: 1_000 });
    }
    const denied = await rl.check({ key: "k2", limit: l, cost: 1, now: 1_000 });
    expect(denied.allowed).toBe(false);

    // Two seconds later: 2 tokens should have refilled.
    const refilled = await rl.check({ key: "k2", limit: l, cost: 1, now: 3_000 });
    expect(refilled).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("isolates per key", async () => {
    const rl = createRedisRateLimiter({ redis: requireRedis(), keyPrefix: "rl:test:" });
    const l = limit({ bucketSize: 1 });

    await rl.check({ key: "a", limit: l, cost: 1, now: 1_000 });
    const aDenied = await rl.check({ key: "a", limit: l, cost: 1, now: 1_000 });
    const bAllowed = await rl.check({ key: "b", limit: l, cost: 1, now: 1_000 });

    expect(aDenied.allowed).toBe(false);
    expect(bAllowed.allowed).toBe(true);
  });

  it("serializes concurrent checks against the same key (atomic Lua script)", async () => {
    const rl = createRedisRateLimiter({ redis: requireRedis(), keyPrefix: "rl:test:" });
    const l = limit({ bucketSize: 3, refillPerSecond: 0.0001 }); // effectively no refill

    const results = await Promise.all(
      Array.from({ length: 10 }, () => rl.check({ key: "concurrent", limit: l, cost: 1 })),
    );
    const allowedCount = results.filter((r) => r.allowed).length;

    // Without atomicity, a race could let more than 3 through. The Lua
    // script makes this deterministic.
    expect(allowedCount).toBe(3);
  });
});
