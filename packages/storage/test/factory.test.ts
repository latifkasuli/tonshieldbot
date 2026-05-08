import { describe, expect, it } from "vitest";
import { createStorage } from "../src/factory.ts";

describe("createStorage", () => {
  it("returns in-memory stores when no databaseUrl is provided", () => {
    const storage = createStorage();

    expect(storage.reports).toBeDefined();
    expect(storage.apiKeys).toBeDefined();
    expect(storage.tenants).toBeDefined();
  });

  it("treats an empty databaseUrl as 'use in-memory'", () => {
    expect(() => createStorage({ databaseUrl: "" })).not.toThrow();
  });

  it("throws loudly when databaseUrl is set but the Postgres impl is not yet built", () => {
    expect(() => createStorage({ databaseUrl: "postgres://localhost/x" })).toThrow(
      /Postgres-backed storage is not yet implemented/i,
    );
  });

  it("returns independent store instances per call", async () => {
    const a = createStorage();
    const b = createStorage();
    await a.tenants.create({ name: "lives in A" });

    expect(await b.tenants.list()).toEqual([]);
  });
});
