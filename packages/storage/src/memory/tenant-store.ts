import { randomUUID } from "node:crypto";
import type { CreateTenantInput, Tenant, TenantStore } from "../interfaces/tenant-store.ts";

export interface InMemoryTenantStoreOptions {
  /** Override clock for deterministic test output. */
  readonly now?: () => Date;
  /** Override id generator for deterministic test output. */
  readonly idGenerator?: () => string;
}

export const createInMemoryTenantStore = (
  options: InMemoryTenantStoreOptions = {},
): TenantStore => {
  const now = options.now ?? (() => new Date());
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const byId = new Map<string, Tenant>();

  return {
    async create(input: CreateTenantInput) {
      const tenant: Tenant = {
        id: idGenerator(),
        name: input.name,
        createdAt: now().toISOString(),
      };

      byId.set(tenant.id, tenant);

      return Promise.resolve(tenant);
    },

    async findById(id) {
      return Promise.resolve(byId.get(id) ?? null);
    },

    async list() {
      return Promise.resolve([...byId.values()]);
    },
  };
};
