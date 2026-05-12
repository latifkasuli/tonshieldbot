import {
  createInMemoryApiKeyStore,
  createInMemoryGiftCatalogStore,
  createInMemoryReportStore,
  createInMemoryTelegramEntityStore,
  createInMemoryTenantStore,
} from "./memory/index.ts";
import type { ApiKeyStore } from "./interfaces/api-key-store.ts";
import type { GiftCatalogStore } from "./interfaces/gift-catalog-store.ts";
import type { ReportStore } from "./interfaces/report-store.ts";
import type { TelegramEntityStore } from "./interfaces/telegram-entity-store.ts";
import type { TenantStore } from "./interfaces/tenant-store.ts";
import {
  createPostgresApiKeyStore,
  createPostgresClient,
  createPostgresGiftCatalogStore,
  createPostgresReportStore,
  createPostgresTelegramEntityStore,
  createPostgresTenantStore,
} from "./postgres/index.ts";
import type { PostgresClient } from "./postgres/index.ts";

export interface Storage {
  readonly reports: ReportStore;
  readonly apiKeys: ApiKeyStore;
  readonly tenants: TenantStore;
  /** Telegram entity snapshot store — see m3-design.md §4. Added in M3 PR-2. */
  readonly telegramEntities: TelegramEntityStore;
  /** Telegram gift-catalog cache — see m3-design.md §4. Added in M3 PR-7. */
  readonly telegramGiftCatalog: GiftCatalogStore;
  /**
   * Releases any underlying resources (e.g. the Postgres pool). Memory
   * storage's close is a no-op. Call on app shutdown.
   */
  readonly close: () => Promise<void>;
}

export interface StorageConfig {
  /**
   * Postgres connection string. When set, the factory wires up Postgres-
   * backed implementations. When unset (or empty), the factory returns
   * in-memory implementations suitable for tests and local dev.
   */
  readonly databaseUrl?: string;
  /** Override the pool max for the Postgres backend. */
  readonly poolMax?: number;
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
    return createPostgresStorage(config.databaseUrl, config.poolMax);
  }

  return {
    reports: createInMemoryReportStore(),
    apiKeys: createInMemoryApiKeyStore(),
    tenants: createInMemoryTenantStore(),
    telegramEntities: createInMemoryTelegramEntityStore(),
    telegramGiftCatalog: createInMemoryGiftCatalogStore(),
    close: () => Promise.resolve(),
  };
};

const createPostgresStorage = (databaseUrl: string, poolMax: number | undefined): Storage => {
  const client: PostgresClient = createPostgresClient(
    poolMax === undefined ? { databaseUrl } : { databaseUrl, poolMax },
  );

  return {
    reports: createPostgresReportStore(client.db),
    apiKeys: createPostgresApiKeyStore(client.db),
    tenants: createPostgresTenantStore(client.db),
    telegramEntities: createPostgresTelegramEntityStore(client.db),
    telegramGiftCatalog: createPostgresGiftCatalogStore(client.db),
    close: client.close,
  };
};
