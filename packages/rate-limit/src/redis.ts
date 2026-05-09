import type Redis from "ioredis";
import type { RateLimitCheck, RateLimitDecision, RateLimiter } from "./limiter.ts";

/**
 * Atomic token-bucket update. Runs server-side in Redis so concurrent
 * checks against the same key serialize cleanly without a round-trip
 * race.
 *
 * KEYS[1]: bucket key
 * ARGV[1]: now (ms since epoch)
 * ARGV[2]: bucket_size (max tokens)
 * ARGV[3]: refill_per_ms (tokens/ms — float)
 * ARGV[4]: cost (tokens to consume)
 * ARGV[5]: ttl_ms (when an idle bucket should expire)
 *
 * Returns: { allowed (0|1), tokens_after, retry_after_ms, full_refill_at_ms }
 */
const TOKEN_BUCKET_LUA = `
local now = tonumber(ARGV[1])
local bucket_size = tonumber(ARGV[2])
local refill_per_ms = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl_ms = tonumber(ARGV[5])

local data = redis.call("HMGET", KEYS[1], "tokens", "last_refill_at")
local tokens = tonumber(data[1])
local last_refill_at = tonumber(data[2])

if tokens == nil then
  tokens = bucket_size
  last_refill_at = now
end

local elapsed = math.max(0, now - last_refill_at)
tokens = math.min(bucket_size, tokens + elapsed * refill_per_ms)

local allowed = 0
local retry_after_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  local deficit = cost - tokens
  retry_after_ms = math.ceil(deficit / refill_per_ms)
end

local missing = bucket_size - tokens
local full_refill_at_ms = now
if missing > 0 then
  full_refill_at_ms = now + math.ceil(missing / refill_per_ms)
end

redis.call("HMSET", KEYS[1], "tokens", tokens, "last_refill_at", now)
redis.call("PEXPIRE", KEYS[1], ttl_ms)

return { allowed, math.floor(tokens), retry_after_ms, full_refill_at_ms }
`;

export interface CreateRedisRateLimiterOptions {
  readonly redis: Redis;
  /**
   * Prefix prepended to every bucket key. Keeps rate-limit keys separate
   * from any other data sharing the Redis instance.
   */
  readonly keyPrefix?: string;
  /**
   * How long an idle bucket sticks around in Redis before being garbage
   * collected. Defaults to 1 hour — long enough that an active client's
   * bucket doesn't churn on every refill, short enough that abandoned
   * keys (e.g. one-shot scans from random IPs) don't accumulate.
   */
  readonly idleTtlMs?: number;
}

export const createRedisRateLimiter = (options: CreateRedisRateLimiterOptions): RateLimiter => {
  const { redis } = options;
  const prefix = options.keyPrefix ?? "rl:";
  const idleTtlMs = options.idleTtlMs ?? 60 * 60 * 1000;

  return {
    async check({ key, limit, cost, now }: RateLimitCheck): Promise<RateLimitDecision> {
      const t = now ?? Date.now();
      const refillPerMs = limit.refillPerSecond / 1000;
      const result = (await redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        `${prefix}${key}`,
        String(t),
        String(limit.bucketSize),
        String(refillPerMs),
        String(cost),
        String(idleTtlMs),
      )) as [number, number, number, number];

      const [allowed, tokensAfter, retryAfterMs, fullRefillAt] = result;

      if (allowed === 1) {
        return { allowed: true, remaining: tokensAfter, fullRefillAt };
      }

      return { allowed: false, retryAfterMs, fullRefillAt };
    },
  };
};
