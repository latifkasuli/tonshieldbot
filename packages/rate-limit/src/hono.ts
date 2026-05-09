import type { Context, MiddlewareHandler } from "hono";
import type { RateLimitTier } from "@tonshield/storage";
import type { RateLimiter } from "./limiter.ts";
import type { TierLimitMap } from "./tiers.ts";

export interface CreateHonoRateLimitOptions {
  readonly limiter: RateLimiter;
  readonly tiers: TierLimitMap;
  /**
   * Extracts a stable identity for the bucket. Common choices:
   *   - tenant id from authenticated context
   *   - `c.req.header("x-forwarded-for")` for unauthenticated public endpoints
   *
   * Returning null skips the rate limit (e.g. an internal callsite that has
   * already authenticated via a different path).
   */
  readonly identify: (c: Context) => string | null;
  /** Resolves the tier for the request. Default: "free". */
  readonly resolveTier?: (c: Context) => RateLimitTier;
  /** Cost of the request. Default: 1. Override for expensive endpoints. */
  readonly cost?: (c: Context) => number;
}

/**
 * Hono middleware. Sets standard rate-limit response headers and returns
 * 429 with `Retry-After` when the limit is exceeded.
 *
 *   X-RateLimit-Limit:     bucket size
 *   X-RateLimit-Remaining: tokens left after this request (allowed only)
 *   X-RateLimit-Reset:     epoch seconds when the bucket fully refills
 *   Retry-After:           seconds to wait (denied only)
 */
export const createHonoRateLimit = (options: CreateHonoRateLimitOptions): MiddlewareHandler => {
  const resolveTier = options.resolveTier ?? ((): RateLimitTier => "free");
  const cost = options.cost ?? (() => 1);

  return async (c, next) => {
    const key = options.identify(c);

    if (key === null) {
      await next();
      return undefined;
    }

    const tier = resolveTier(c);
    const limit = options.tiers[tier];
    const decision = await options.limiter.check({ key, limit, cost: cost(c) });

    c.header("X-RateLimit-Limit", String(limit.bucketSize));
    c.header("X-RateLimit-Reset", String(Math.ceil(decision.fullRefillAt / 1000)));

    if (!decision.allowed) {
      c.header("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)));

      return c.json(
        {
          error: "rate_limited",
          retryAfterMs: decision.retryAfterMs,
        },
        429,
      );
    }

    c.header("X-RateLimit-Remaining", String(decision.remaining));
    await next();
    return undefined;
  };
};
