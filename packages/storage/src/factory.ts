import {
  createInMemoryApiKeyStore,
  createInMemoryReportStore,
  createInMemoryTenantStore,
} from "./memory/index.ts";
import type { ApiKeyStore } from "./interfaces/api-key-store.ts";
import type { ReportStore } from "./interfaces/report-store.ts";
import type { TenantStore } from "./interfaces/tenant-store.ts";

export interface Storage {
  readonly reports: ReportStore;
  readonly apiKeys: ApiKeyStore;
  readonly tenants: TenantStore;
}

export interface StorageConfig {
  /**
   * Postgres connection string. When set, the factory wires up Postgres-
   * backed implementations. When unset, the factory returns in-memory
   * implementations suitable for tests and local dev.
   *
   * The Postgres branch is added in a follow-up PR; for now an unsupported
   * value throws so misconfiguration fails loudly rather than silently
   * falling back to in-memory in production.
   */
  readonly databaseUrl?: string;
}

/**
 * Builds a `Storage` bundle from configuration. The api/bot wire this up
 * once at startup and pass the bundle (or its individual stores) into the
 * code that needs them.
 *
 * Memory stores are independent instances per call — do not call this
 * twice and expect the second call to see writes from the first.
 */
export const createStorage = (config: StorageConfig = {}): Storage => {
  if (config.databaseUrl !== undefined && config.databaseUrl.length > 0) {
    throw new Error(
      "Postgres-backed storage is not yet implemented. " +
        "Unset DATABASE_URL to use in-memory storage, or wait for the Postgres impl PR.",
    );
  }

  return {
    reports: createInMemoryReportStore(),
    apiKeys: createInMemoryApiKeyStore(),
    tenants: createInMemoryTenantStore(),
  };
};
