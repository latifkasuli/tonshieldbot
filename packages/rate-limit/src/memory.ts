import type { RateLimitCheck, RateLimitDecision, RateLimiter } from "./limiter.ts";

interface BucketState {
  tokens: number;
  lastRefillAt: number;
}

/**
 * In-memory token-bucket limiter. Single-process only — useful for tests
 * and for the bot's own per-user limit (since the bot is one process).
 *
 * For the api running on multiple Railway instances, use the Redis impl
 * so all instances share the same bucket.
 */
export const createInMemoryRateLimiter = (): RateLimiter => {
  const buckets = new Map<string, BucketState>();

  return {
    check({ key, limit, cost, now }: RateLimitCheck): Promise<RateLimitDecision> {
      const t = now ?? Date.now();
      const previous = buckets.get(key);
      const startingTokens = previous?.tokens ?? limit.bucketSize;
      const lastRefillAt = previous?.lastRefillAt ?? t;
      const elapsedMs = Math.max(0, t - lastRefillAt);
      const refilled = Math.min(
        limit.bucketSize,
        startingTokens + (elapsedMs * limit.refillPerSecond) / 1000,
      );

      if (refilled >= cost) {
        const remainingTokens = refilled - cost;
        buckets.set(key, { tokens: remainingTokens, lastRefillAt: t });

        return Promise.resolve({
          allowed: true,
          remaining: Math.floor(remainingTokens),
          fullRefillAt: fullRefillAt(t, remainingTokens, limit),
        });
      }

      // Deny without consuming tokens. Update the timestamp so the refill
      // calculation stays correct on the next call.
      buckets.set(key, { tokens: refilled, lastRefillAt: t });
      const retryAfterMs = Math.ceil(((cost - refilled) * 1000) / limit.refillPerSecond);

      return Promise.resolve({
        allowed: false,
        retryAfterMs,
        fullRefillAt: fullRefillAt(t, refilled, limit),
      });
    },
  };
};

const fullRefillAt = (now: number, currentTokens: number, limit: TierLimitForRefill): number => {
  const missing = limit.bucketSize - currentTokens;

  if (missing <= 0) {
    return now;
  }

  return now + Math.ceil((missing * 1000) / limit.refillPerSecond);
};

interface TierLimitForRefill {
  readonly bucketSize: number;
  readonly refillPerSecond: number;
}
