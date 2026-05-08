import { afterEach, describe, expect, it } from "vitest";
import { createStorage } from "../src/factory.ts";
import type { Storage } from "../src/factory.ts";

describe("createStorage", () => {
  const created: Storage[] = [];

  afterEach(async () => {
    while (created.length > 0) {
      const storage = created.pop();
      await storage?.close();
    }
  });

  const make = (config?: Parameters<typeof createStorage>[0]): Storage => {
    const s = createStorage(config);
    created.push(s);
    return s;
  };

  it("returns in-memory stores when no databaseUrl is provided", () => {
    const storage = make();

    expect(storage.reports).toBeDefined();
    expect(storage.apiKeys).toBeDefined();
    expect(storage.tenants).toBeDefined();
  });

  it("treats an empty databaseUrl as 'use in-memory'", () => {
    expect(() => make({ databaseUrl: "" })).not.toThrow();
  });

  it("returns independent in-memory store instances per call", async () => {
    const a = make();
    const b = make();
    await a.tenants.create({ name: "lives in A" });

    expect(await b.tenants.list()).toEqual([]);
  });

  it("memory storage close is a no-op that resolves", async () => {
    const storage = make();

    await expect(storage.close()).resolves.toBeUndefined();
  });
});
