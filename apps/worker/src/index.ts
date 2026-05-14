import { createLogger } from "@tonshield/logger";
import { createStorage } from "@tonshield/storage";
import { createTelegramIntelClient } from "@tonshield/telegram-intel";
import { loadWorkerConfig } from "./env.ts";
import { startGiftCatalogRefreshLoop } from "./refresh-loop.ts";
import { startSnapshotRetentionLoop } from "./retention-loop.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const config = loadWorkerConfig();
const logger = createLogger({ service: "tonshield-worker" });

const storage = createStorage(
  config.databaseUrl === undefined ? {} : { databaseUrl: config.databaseUrl },
);

const telegramIntel = createTelegramIntelClient({
  token: config.telegramIntelBotToken ?? null,
  apiBaseUrl: config.telegramApiBaseUrl ?? "https://api.telegram.org",
});

logger.info(
  {
    storage: config.databaseUrl === undefined ? "memory" : "postgres",
    telegram_intel_enabled: telegramIntel.enabled,
    gift_catalog_refresh_interval_ms: config.giftCatalogRefreshIntervalMs,
    snapshot_retention_interval_ms: config.snapshotRetentionIntervalMs,
    snapshot_retention_days: config.snapshotRetentionDays,
    snapshot_retention_max_rows_per_run: config.snapshotRetentionMaxRowsPerRun,
  },
  "worker_starting",
);

const giftCatalogLoop = startGiftCatalogRefreshLoop({
  client: telegramIntel,
  store: storage.telegramGiftCatalog,
  logger,
  intervalMs: config.giftCatalogRefreshIntervalMs,
});

const retentionLoop = startSnapshotRetentionLoop({
  store: storage.telegramEntities,
  logger,
  intervalMs: config.snapshotRetentionIntervalMs,
  retentionMs: config.snapshotRetentionDays * MS_PER_DAY,
  maxRowsPerRun: config.snapshotRetentionMaxRowsPerRun,
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, "worker_shutting_down");
  giftCatalogLoop.stop();
  retentionLoop.stop();
  await Promise.all([giftCatalogLoop.currentTick(), retentionLoop.currentTick()]);
  await storage.close();
  process.exit(0);
};

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
