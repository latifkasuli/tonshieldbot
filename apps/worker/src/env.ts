import { z } from "zod";

/**
 * Worker process config. Same env conventions as `apps/api` so a single
 * `.env` works for both. The worker drives long-running background jobs
 * (currently: the periodic gift-catalog refresh).
 */
const envSchema = z.object({
  DATABASE_URL: z.string().optional(),
  TELEGRAM_INTEL_BOT_TOKEN: z.string().optional(),
  TELEGRAM_API_BASE_URL: z.string().optional(),
  /**
   * How often (in ms) to call `getAvailableGifts` and refresh the catalog
   * cache. Telegram's catalog changes infrequently (new gift drops every
   * few weeks). Default 1h is the conservative midpoint — short enough
   * that a fresh drop becomes available to scans within an hour, long
   * enough that we don't burn rate-limit budget. Tests / one-shot
   * invocations can override down to 60s.
   */
  GIFT_CATALOG_REFRESH_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60 * 1000)
    .default(60 * 60 * 1000),
});

export interface WorkerConfig {
  readonly databaseUrl: string | undefined;
  readonly telegramIntelBotToken: string | undefined;
  readonly telegramApiBaseUrl: string | undefined;
  readonly giftCatalogRefreshIntervalMs: number;
}

export const loadWorkerConfig = (env: NodeJS.ProcessEnv = process.env): WorkerConfig => {
  const parsed = envSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    telegramIntelBotToken: parsed.TELEGRAM_INTEL_BOT_TOKEN,
    telegramApiBaseUrl: parsed.TELEGRAM_API_BASE_URL,
    giftCatalogRefreshIntervalMs: parsed.GIFT_CATALOG_REFRESH_INTERVAL_MS,
  };
};
