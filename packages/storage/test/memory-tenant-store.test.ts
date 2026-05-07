import { describe, expect, it } from "vitest";
import { createInMemoryTenantStore } from "../src/memory/tenant-store.ts";

describe("createInMemoryTenantStore", () => {
  it("create persists a tenant and assigns an id and createdAt", async () => {
    const store = createInMemoryTenantStore({
      now: () => new Date("2026-05-07T12:00:00.000Z"),
      idGenerator: () => "tenant_1",
    });

    const tenant = await store.create({ name: "Acme" });

    expect(tenant).toEqual({
      id: "tenant_1",
      name: "Acme",
      createdAt: "2026-05-07T12:00:00.000Z",
    });
  });

  it("findById returns null for unknown tenants", async () => {
    const store = createInMemoryTenantStore();

    expect(await store.findById("missing")).toBeNull();
  });

  it("list returns all tenants in insertion order", async () => {
    let nextId = 0;
    const store = createInMemoryTenantStore({
      idGenerator: () => `tenant_${String(nextId++)}`,
    });

    await store.create({ name: "First" });
    await store.create({ name: "Second" });

    const all = await store.list();

    expect(all.map((t) => t.name)).toEqual(["First", "Second"]);
  });
});
