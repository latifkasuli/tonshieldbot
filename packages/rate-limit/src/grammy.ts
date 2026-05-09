import type { Context as GrammyContext, MiddlewareFn } from "grammy";
import type { RateLimitTier } from "@tonshield/storage";
import type { RateLimitDecision, RateLimiter } from "./limiter.ts";
import type { TierLimitMap } from "./tiers.ts";

export interface CreateGrammyRateLimitOptions<C extends GrammyContext = GrammyContext> {
  readonly limiter: RateLimiter;
  readonly tiers: TierLimitMap;
  /**
   * Extracts a stable identity for the bucket. The default uses the
   * Telegram user id when present and skips the limit otherwise (e.g.
   * channel posts with no `from`).
   */
  readonly identify?: (ctx: C) => string | null;
  /** Resolves the tier for this update. Default: "free". */
  readonly resolveTier?: (ctx: C) => RateLimitTier;
  /** Cost of the update. Default: 1. */
  readonly cost?: (ctx: C) => number;
  /**
   * Called when an update is rate-limited. The default replies with a
   * short message in English. Override to customize copy or stay silent.
   */
  readonly onLimit?: (
    ctx: C,
    decision: Extract<RateLimitDecision, { allowed: false }>,
  ) => Promise<void>;
}

const defaultOnLimit = async (
  ctx: GrammyContext,
  decision: Extract<RateLimitDecision, { allowed: false }>,
): Promise<void> => {
  const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));

  await ctx.reply(`You are sending requests too fast. Try again in ${String(seconds)}s.`);
};

/**
 * grammy middleware. When the limit is exceeded, calls `onLimit` and
 * does NOT pass control to the next handler — the scan/work that the
 * downstream handler would have done is skipped.
 */
export const createGrammyRateLimit = <C extends GrammyContext = GrammyContext>(
  options: CreateGrammyRateLimitOptions<C>,
): MiddlewareFn<C> => {
  const identify = options.identify ?? ((ctx: C) => (ctx.from ? String(ctx.from.id) : null));
  const resolveTier = options.resolveTier ?? ((): RateLimitTier => "free");
  const cost = options.cost ?? (() => 1);
  const onLimit = options.onLimit ?? defaultOnLimit;

  return async (ctx, next) => {
    const key = identify(ctx);

    if (key === null) {
      await next();
      return;
    }

    const tier = resolveTier(ctx);
    const limit = options.tiers[tier];
    const decision = await options.limiter.check({ key, limit, cost: cost(ctx) });

    if (!decision.allowed) {
      await onLimit(ctx, decision);
      return;
    }

    await next();
  };
};
