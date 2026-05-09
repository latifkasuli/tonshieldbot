import type { RateLimitTier } from "@tonshield/storage";

/**
 * Token-bucket parameters for a tier.
 *
 * - `bucketSize` is the maximum burst (tokens you can spend in an instant
 *   when the bucket is full).
 * - `refillPerSecond` is the steady-state rate (tokens per second).
 *
 * A request consumes `cost` tokens (default 1). Most read calls cost 1;
 * expensive operations (e.g. an emulation-triggering scan) can cost more.
 */
export interface TierLimit {
  readonly bucketSize: number;
  readonly refillPerSecond: number;
}

export type TierLimitMap = Readonly<Record<RateLimitTier, TierLimit>>;

/**
 * Defaults targeting "1 req/sec sustained for free, generous for partner,
 * effectively unlimited for internal." Operators override these per
 * environment via the `tiers` arg on the middleware factories.
 */
export const defaultTierLimits: TierLimitMap = {
  free: { bucketSize: 30, refillPerSecond: 1 },
  partner: { bucketSize: 100, refillPerSecond: 10 },
  internal: { bucketSize: 1000, refillPerSecond: 100 },
};
