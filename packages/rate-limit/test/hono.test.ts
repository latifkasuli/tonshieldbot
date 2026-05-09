import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createHonoRateLimit } from "../src/hono.ts";
import { createInMemoryRateLimiter } from "../src/memory.ts";
import type { TierLimitMap } from "../src/tiers.ts";

const tiers: TierLimitMap = {
  free: { bucketSize: 2, refillPerSecond: 1 },
  partner: { bucketSize: 10, refillPerSecond: 5 },
  internal: { bucketSize: 100, refillPerSecond: 50 },
};

const buildApp = (identify: (clientId: string | null) => string | null = () => "anon"): Hono => {
  const app = new Hono();
  app.use(
    "*",
    createHonoRateLimit({
      limiter: createInMemoryRateLimiter(),
      tiers,
      identify: (c) => identify(c.req.header("x-client-id") ?? null),
    }),
  );
  app.get("/ping", (c) => c.json({ ok: true }));

  return app;
};

describe("createHonoRateLimit", () => {
  it("allows requests within the bucket and emits standard headers", async () => {
    const app = buildApp();

    const res = await app.request("/ping");

    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("1");
    expect(res.headers.get("X-RateLimit-Reset")).toMatch(/^\d+$/);
  });

  it("returns 429 with Retry-After when the bucket is drained", async () => {
    const app = buildApp();

    await app.request("/ping");
    await app.request("/ping");
    const denied = await app.request("/ping");

    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toMatch(/^\d+$/);
    const body = (await denied.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });

  it("skips the limit when identify returns null", async () => {
    const app = buildApp(() => null);

    for (let i = 0; i < 10; i += 1) {
      const res = await app.request("/ping");
      expect(res.status).toBe(200);
    }
  });

  it("isolates identities", async () => {
    const app = buildApp((clientId) => clientId);

    await app.request("/ping", { headers: { "x-client-id": "a" } });
    await app.request("/ping", { headers: { "x-client-id": "a" } });
    const aDenied = await app.request("/ping", { headers: { "x-client-id": "a" } });
    const bAllowed = await app.request("/ping", { headers: { "x-client-id": "b" } });

    expect(aDenied.status).toBe(429);
    expect(bAllowed.status).toBe(200);
  });
});
