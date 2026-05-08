import { eq } from "drizzle-orm";
import type { CreateTenantInput, Tenant, TenantStore } from "../interfaces/tenant-store.ts";
import type { StorageDb } from "./client.ts";
import { tenants } from "./schema.ts";

interface DbTenant {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
}

const toTenant = (row: DbTenant): Tenant => ({
  id: row.id,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
});

export const createPostgresTenantStore = (db: StorageDb): TenantStore => ({
  async create(input: CreateTenantInput) {
    const [row] = await db.insert(tenants).values({ name: input.name }).returning();

    if (row === undefined) {
      throw new Error("INSERT INTO tenants returned no row");
    }

    return toTenant(row);
  },

  async findById(id) {
    const rows = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    const row = rows[0];

    return row === undefined ? null : toTenant(row);
  },

  async list() {
    const rows = await db.select().from(tenants);

    return rows.map(toTenant);
  },
});
