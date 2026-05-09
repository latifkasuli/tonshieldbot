import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryApiKeyStore, createInMemoryTenantStore } from "@tonshield/storage";
import type { ApiKeyStore } from "@tonshield/storage";
import { createApiKeyAuth } from "../src/hono.ts";
import type { AuthVariables } from "../src/hono.ts";

interface TestSetup {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly apiKeys: ApiKeyStore;
  readonly rawKey: string;
}

const buildApp = async (
  options: { trackLastUsed?: boolean; onAuthFailure?: () => void; onAuthSuccess?: () => void } = {},
): Promise<TestSetup> => {
  const tenants = createInMemoryTenantStore();
  const apiKeys = createInMemoryApiKeyStore({ keyGenerator: () => "tsk_known_key" });
  const tenant = await tenants.create({ name: "Acme" });
  await apiKeys.create({
    tenantId: tenant.id,
    name: "primary",
    scopes: ["scan:write"],
    rateLimitTier: "partner",
  });

  const app = new Hono<{ Variables: AuthVariables }>();
  app.use(
    "/v1/*",
    createApiKeyAuth({
      apiKeys,
      ...(options.trackLastUsed !== undefined ? { trackLastUsed: options.trackLastUsed } : {}),
      ...(options.onAuthFailure !== undefined ? { onAuthFailure: options.onAuthFailure } : {}),
      ...(options.onAuthSuccess !== undefined ? { onAuthSuccess: options.onAuthSuccess } : {}),
    }),
  );
  app.get("/v1/echo", (c) =>
    c.json({ tenantId: c.var.apiKey.tenantId, tier: c.var.apiKey.rateLimitTier }),
  );
  app.get("/health", (c) => c.json({ ok: true }));

  return { app, apiKeys, rawKey: "tsk_known_key" };
};

describe("createApiKeyAuth", () => {
  it("authenticates a valid Bearer token and exposes the resolved key on c.var", async () => {
    const { app, rawKey } = await buildApp();

    const res = await app.request("/v1/echo", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: string; tier: string };
    expect(body.tenantId).toBeDefined();
    expect(body.tier).toBe("partner");
  });

  it("authenticates via X-API-Key when Authorization is absent", async () => {
    const { app, rawKey } = await buildApp();

    const res = await app.request("/v1/echo", { headers: { "X-API-Key": rawKey } });

    expect(res.status).toBe(200);
  });

  it("returns 401 with a generic body when no credentials are presented", async () => {
    const { app } = await buildApp();

    const res = await app.request("/v1/echo");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 for an unknown key (does not reveal it was wrong vs missing)", async () => {
    const { app } = await buildApp();

    const res = await app.request("/v1/echo", {
      headers: { Authorization: "Bearer tsk_does_not_exist" },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 for a revoked key", async () => {
    const { app, apiKeys, rawKey } = await buildApp();
    const [meta] = await apiKeys.listByTenant(
      (await apiKeys.verify(rawKey))?.tenantId ?? "missing",
    );

    if (meta === undefined) {
      throw new Error("test fixture missing");
    }

    await apiKeys.revoke(meta.id);

    const res = await app.request("/v1/echo", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(res.status).toBe(401);
  });

  it("does not require auth on routes outside the middleware mount path", async () => {
    const { app } = await buildApp();

    const res = await app.request("/health");

    expect(res.status).toBe(200);
  });

  it("invokes onAuthFailure with the appropriate reason", async () => {
    const onAuthFailure = vi.fn();
    const { app } = await buildApp({ onAuthFailure });

    await app.request("/v1/echo");
    await app.request("/v1/echo", { headers: { Authorization: "Bearer wrong" } });

    expect(onAuthFailure.mock.calls[0]?.[0]).toBe("missing_key");
    expect(onAuthFailure.mock.calls[1]?.[0]).toBe("invalid_key");
  });

  it("invokes onAuthSuccess with the resolved key on every authenticated request", async () => {
    const onAuthSuccess = vi.fn();
    const { app, rawKey } = await buildApp({ onAuthSuccess });

    await app.request("/v1/echo", { headers: { Authorization: `Bearer ${rawKey}` } });

    expect(onAuthSuccess).toHaveBeenCalledTimes(1);
    const resolved = onAuthSuccess.mock.calls[0]?.[0] as { rateLimitTier: string };
    expect(resolved.rateLimitTier).toBe("partner");
  });

  it("hook errors do not break the response", async () => {
    const { app, rawKey } = await buildApp({
      onAuthSuccess: () => {
        throw new Error("oops");
      },
    });

    const res = await app.request("/v1/echo", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(res.status).toBe(200);
  });

  it("calls touchLastUsed on success when trackLastUsed is enabled", async () => {
    const { app, apiKeys, rawKey } = await buildApp();
    const touchSpy = vi.spyOn(apiKeys, "touchLastUsed");

    await app.request("/v1/echo", { headers: { Authorization: `Bearer ${rawKey}` } });
    // Fire-and-forget — give the microtask queue a chance to flush.
    await new Promise((resolve) => setImmediate(resolve));

    expect(touchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not call touchLastUsed when trackLastUsed is disabled", async () => {
    const { app, apiKeys, rawKey } = await buildApp({ trackLastUsed: false });
    const touchSpy = vi.spyOn(apiKeys, "touchLastUsed");

    await app.request("/v1/echo", { headers: { Authorization: `Bearer ${rawKey}` } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(touchSpy).not.toHaveBeenCalled();
  });

  it("does not surface touchLastUsed errors as 5xx", async () => {
    const { app, apiKeys, rawKey } = await buildApp();
    vi.spyOn(apiKeys, "touchLastUsed").mockRejectedValueOnce(new Error("redis down"));

    const res = await app.request("/v1/echo", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(res.status).toBe(200);
  });
});
