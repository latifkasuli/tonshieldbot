import type { TierLimit } from "./tiers.ts";

/**
 * Outcome of a rate-limit check.
 *
 * Discriminated union so callers cannot accidentally read `retryAfterMs`
 * on an allowed decision or `remaining` on a denied one.
 */
export type RateLimitDecision =
  | {
      readonly allowed: true;
      readonly remaining: number;
      /** Epoch millis when the bucket would be fully refilled. */
      readonly fullRefillAt: number;
    }
  | {
      readonly allowed: false;
      readonly retryAfterMs: number;
      readonly fullRefillAt: number;
    };

export interface RateLimitCheck {
  /** Stable identity for the bucket — a tenant id, an IP, a Telegram user id, etc. */
  readonly key: string;
  readonly limit: TierLimit;
  /** Tokens to consume. Defaults to 1 in the middleware layer. */
  readonly cost: number;
  /** Override clock for tests. Defaults to `Date.now()` inside the impl. */
  readonly now?: number;
}

/**
 * Atomic token-bucket primitive. Implementations must be safe under
 * concurrent calls on the same `key` — the Redis impl uses a Lua script
 * for that, the in-memory impl uses a per-key Mutex-equivalent.
 */
export interface RateLimiter {
  check(input: RateLimitCheck): Promise<RateLimitDecision>;
}
