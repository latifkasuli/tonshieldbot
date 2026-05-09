import { describe, expect, it, vi } from "vitest";
import { createGrammyRateLimit } from "../src/grammy.ts";
import { createInMemoryRateLimiter } from "../src/memory.ts";
import type { TierLimitMap } from "../src/tiers.ts";

const tiers: TierLimitMap = {
  free: { bucketSize: 1, refillPerSecond: 1 },
  partner: { bucketSize: 10, refillPerSecond: 5 },
  internal: { bucketSize: 100, refillPerSecond: 50 },
};

interface FakeContext {
  from: { id: number } | undefined;
  reply: (text: string) => Promise<void>;
}

const makeCtx = (userId: number | undefined): FakeContext => ({
  from: userId === undefined ? undefined : { id: userId },
  reply: vi.fn().mockResolvedValue(undefined),
});

describe("createGrammyRateLimit", () => {
  it("calls next when allowed", async () => {
    // The middleware is generic over the grammy Context type. The test
    // exercises only the surface the middleware actually touches.
    const middleware = createGrammyRateLimit({
      limiter: createInMemoryRateLimiter(),
      tiers,
    }) as unknown as (ctx: FakeContext, next: () => Promise<void>) => Promise<void>;

    const ctx = makeCtx(42);
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("calls onLimit and skips next when the bucket is drained", async () => {
    const onLimit = vi.fn().mockResolvedValue(undefined);
    const middleware = createGrammyRateLimit({
      limiter: createInMemoryRateLimiter(),
      tiers,
      onLimit,
    }) as unknown as (ctx: FakeContext, next: () => Promise<void>) => Promise<void>;

    const ctx = makeCtx(42);
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next); // consumes the only token
    await middleware(ctx, next); // denied

    expect(next).toHaveBeenCalledTimes(1);
    expect(onLimit).toHaveBeenCalledTimes(1);
  });

  it("skips the limit when from.id is missing (e.g. channel posts)", async () => {
    const middleware = createGrammyRateLimit({
      limiter: createInMemoryRateLimiter(),
      tiers,
    }) as unknown as (ctx: FakeContext, next: () => Promise<void>) => Promise<void>;

    const ctx = makeCtx(undefined);
    const next = vi.fn().mockResolvedValue(undefined);

    for (let i = 0; i < 5; i += 1) {
      await middleware(ctx, next);
    }

    expect(next).toHaveBeenCalledTimes(5);
  });

  it("default onLimit replies with a retry hint mentioning seconds", async () => {
    const middleware = createGrammyRateLimit({
      limiter: createInMemoryRateLimiter(),
      tiers,
    }) as unknown as (ctx: FakeContext, next: () => Promise<void>) => Promise<void>;

    const ctx = makeCtx(7);
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);
    await middleware(ctx, next);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyMock = ctx.reply as ReturnType<typeof vi.fn>;
    const replyText = replyMock.mock.calls[0]?.[0] as string;
    expect(replyText).toMatch(/\d+s/);
  });
});
