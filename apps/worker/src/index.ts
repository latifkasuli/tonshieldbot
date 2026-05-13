import { createLogger } from "@tonshield/logger";
import { createStorage } from "@tonshield/storage";
import { createTelegramIntelClient } from "@tonshield/telegram-intel";
import { loadWorkerConfig } from "./env.ts";
import { startGiftCatalogRefreshLoop } from "./refresh-loop.ts";

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
  },
  "worker_starting",
);

const loop = startGiftCatalogRefreshLoop({
  client: telegramIntel,
  store: storage.telegramGiftCatalog,
  logger,
  intervalMs: config.giftCatalogRefreshIntervalMs,
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, "worker_shutting_down");
  loop.stop();
  await loop.currentTick();
  await storage.close();
  process.exit(0);
};

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
