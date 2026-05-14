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
  /**
   * How often (in ms) to run the snapshot retention sweep. Default 24h —
   * snapshots accumulate slowly and the cutoff is days-grained, so
   * sub-day cadence has no benefit. Minimum 60s for testing.
   */
  SNAPSHOT_RETENTION_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(7 * 24 * 60 * 60 * 1000)
    .default(24 * 60 * 60 * 1000),
  /**
   * Snapshot retention window in DAYS. Per design doc decision #9, the
   * default is 365 days for public-entity snapshots. Operators can
   * tighten this without code changes; tests use a small value.
   * Minimum 1 day floor avoids accidentally nuking the table on a typo.
   */
  SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
  /**
   * Per-run delete cap. Bounds blast radius if the retention window is
   * misconfigured. 100k rows is roughly two minutes of Postgres work at
   * worst — enough to chip away at a real backlog without blocking other
   * worker activity.
   */
  SNAPSHOT_RETENTION_MAX_ROWS_PER_RUN: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(100_000),
});

export interface WorkerConfig {
  readonly databaseUrl: string | undefined;
  readonly telegramIntelBotToken: string | undefined;
  readonly telegramApiBaseUrl: string | undefined;
  readonly giftCatalogRefreshIntervalMs: number;
  readonly snapshotRetentionIntervalMs: number;
  readonly snapshotRetentionDays: number;
  readonly snapshotRetentionMaxRowsPerRun: number;
}

export const loadWorkerConfig = (env: NodeJS.ProcessEnv = process.env): WorkerConfig => {
  const parsed = envSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    telegramIntelBotToken: parsed.TELEGRAM_INTEL_BOT_TOKEN,
    telegramApiBaseUrl: parsed.TELEGRAM_API_BASE_URL,
    giftCatalogRefreshIntervalMs: parsed.GIFT_CATALOG_REFRESH_INTERVAL_MS,
    snapshotRetentionIntervalMs: parsed.SNAPSHOT_RETENTION_INTERVAL_MS,
    snapshotRetentionDays: parsed.SNAPSHOT_RETENTION_DAYS,
    snapshotRetentionMaxRowsPerRun: parsed.SNAPSHOT_RETENTION_MAX_ROWS_PER_RUN,
  };
};
