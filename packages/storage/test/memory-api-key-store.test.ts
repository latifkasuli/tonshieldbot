import { describe, expect, it } from "vitest";
import { createInMemoryApiKeyStore } from "../src/memory/api-key-store.ts";

const fixedClock = () => new Date("2026-05-07T12:00:00.000Z");

describe("createInMemoryApiKeyStore", () => {
  it("create returns a raw key once and persists only the hash", async () => {
    const store = createInMemoryApiKeyStore({
      now: fixedClock,
      idGenerator: () => "key_1",
      keyGenerator: () => "tsk_raw_value",
    });

    const created = await store.create({
      tenantId: "tenant_1",
      name: "primary",
      scopes: ["scan:write"],
      rateLimitTier: "internal",
    });

    expect(created.rawKey).toBe("tsk_raw_value");
    expect(created.metadata).toEqual({
      id: "key_1",
      tenantId: "tenant_1",
      scopes: ["scan:write"],
      rateLimitTier: "internal",
      name: "primary",
      createdAt: "2026-05-07T12:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    });

    // Exposing the raw key should not be possible after creation.
    const reread = await store.findById("key_1");

    expect(reread).not.toHaveProperty("rawKey");
    expect(reread).not.toHaveProperty("hash");
  });

  it("verify resolves a valid raw key to the tenant + scopes + tier", async () => {
    const store = createInMemoryApiKeyStore({ keyGenerator: () => "tsk_secret" });
    await store.create({
      tenantId: "tenant_x",
      name: "p",
      scopes: ["scan:read", "scan:write"],
      rateLimitTier: "partner",
    });

    const resolved = await store.verify("tsk_secret");

    expect(resolved).toMatchObject({
      tenantId: "tenant_x",
      scopes: ["scan:read", "scan:write"],
      rateLimitTier: "partner",
    });
  });

  it("verify returns null for an unknown raw key", async () => {
    const store = createInMemoryApiKeyStore();

    expect(await store.verify("tsk_does_not_exist")).toBeNull();
  });

  it("verify returns null for a revoked key", async () => {
    const store = createInMemoryApiKeyStore({
      idGenerator: () => "key_1",
      keyGenerator: () => "tsk_revokeable",
    });
    await store.create({
      tenantId: "t",
      name: "x",
      scopes: ["scan:read"],
      rateLimitTier: "free",
    });
    await store.revoke("key_1");

    expect(await store.verify("tsk_revokeable")).toBeNull();
  });

  it("revoke is idempotent and does not move revokedAt on a second call", async () => {
    let now = new Date("2026-05-07T12:00:00.000Z");
    const store = createInMemoryApiKeyStore({
      now: () => now,
      idGenerator: () => "key_1",
    });
    await store.create({
      tenantId: "t",
      name: "x",
      scopes: ["scan:read"],
      rateLimitTier: "free",
    });

    await store.revoke("key_1");
    const firstRevoke = (await store.findById("key_1"))?.revokedAt;

    now = new Date("2026-05-08T12:00:00.000Z");
    await store.revoke("key_1");
    const secondRevoke = (await store.findById("key_1"))?.revokedAt;

    expect(firstRevoke).toBe("2026-05-07T12:00:00.000Z");
    expect(secondRevoke).toBe(firstRevoke);
  });

  it("revoke throws on an unknown id", async () => {
    const store = createInMemoryApiKeyStore();

    await expect(store.revoke("missing")).rejects.toThrow(/not found/i);
  });

  it("listByTenant filters by tenant", async () => {
    let i = 0;
    const store = createInMemoryApiKeyStore({
      idGenerator: () => `key_${String(i++)}`,
      keyGenerator: () => `tsk_${String(i)}`,
    });

    await store.create({ tenantId: "a", name: "x", scopes: [], rateLimitTier: "free" });
    await store.create({ tenantId: "a", name: "y", scopes: [], rateLimitTier: "free" });
    await store.create({ tenantId: "b", name: "z", scopes: [], rateLimitTier: "free" });

    const aKeys = await store.listByTenant("a");
    const bKeys = await store.listByTenant("b");

    expect(aKeys.map((k) => k.name)).toEqual(["x", "y"]);
    expect(bKeys.map((k) => k.name)).toEqual(["z"]);
  });

  it("touchLastUsed updates lastUsedAt", async () => {
    let now = new Date("2026-05-07T12:00:00.000Z");
    const store = createInMemoryApiKeyStore({
      now: () => now,
      idGenerator: () => "key_1",
    });
    await store.create({
      tenantId: "t",
      name: "x",
      scopes: [],
      rateLimitTier: "free",
    });

    expect((await store.findById("key_1"))?.lastUsedAt).toBeNull();

    now = new Date("2026-05-07T13:30:00.000Z");
    await store.touchLastUsed("key_1");

    expect((await store.findById("key_1"))?.lastUsedAt).toBe("2026-05-07T13:30:00.000Z");
  });

  it("touchLastUsed on a missing id is a silent no-op", async () => {
    const store = createInMemoryApiKeyStore();

    await expect(store.touchLastUsed("missing")).resolves.toBeUndefined();
  });
});
