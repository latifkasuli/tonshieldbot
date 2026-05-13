import type { Logger } from "@tonshield/logger";
import type { GiftCatalogStore } from "@tonshield/storage";
import type { TelegramIntelClient } from "@tonshield/telegram-intel";
import { refreshGiftCatalog } from "@tonshield/ton-scanner";

/**
 * Periodic gift-catalog refresh. Calls `refreshGiftCatalog` once
 * immediately on start, then on a fixed interval until `stop()`.
 *
 * Failure handling: errors are logged but do not stop the loop. The
 * worker is a long-running process and one bad refresh shouldn't take
 * the whole job offline. The next tick will retry; eventually we'll see
 * green again or operations will notice the rate of failures.
 *
 * Why setInterval over a job queue: we have a single global periodic
 * action (one tenant, one catalog) — a full BullMQ-style queue adds
 * Redis as a hard dep with no proportional benefit. If we add more
 * scheduled work later, this module is the right place to grow into a
 * scheduler abstraction.
 */
export interface RefreshLoopHandle {
  /** Stop scheduling further ticks. Already-running ticks complete. */
  readonly stop: () => void;
  /**
   * Promise that resolves when the next-pending tick completes. Useful
   * for tests; production callers should ignore it.
   */
  readonly currentTick: () => Promise<void>;
}

export interface StartRefreshLoopOptions {
  readonly client: TelegramIntelClient;
  readonly store: GiftCatalogStore;
  readonly logger: Logger;
  readonly intervalMs: number;
  /** Inject `setInterval` / `clearInterval` for tests. Defaults to globals. */
  readonly schedule?: {
    readonly setInterval: typeof setInterval;
    readonly clearInterval: typeof clearInterval;
  };
  /** Inject `now()` for tests. Defaults to `Date.now`. */
  readonly now?: () => Date;
}

export const startGiftCatalogRefreshLoop = (
  options: StartRefreshLoopOptions,
): RefreshLoopHandle => {
  const setIntervalFn = options.schedule?.setInterval ?? setInterval;
  const clearIntervalFn = options.schedule?.clearInterval ?? clearInterval;
  const now = options.now ?? (() => new Date());

  let inFlight: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    try {
      const result = await refreshGiftCatalog(options.client, options.store, now());
      if (result.status === "ok") {
        options.logger.info(
          {
            refreshed_count: result.refreshedCount,
            refreshed_at: result.refreshedAt.toISOString(),
          },
          "gift_catalog_refreshed",
        );
      } else if (result.status === "disabled") {
        options.logger.info({}, "gift_catalog_refresh_skipped_disabled");
      } else {
        options.logger.warn({ failure: result.failure }, "gift_catalog_refresh_failed");
      }
    } catch (error) {
      // refreshGiftCatalog itself returns a result rather than throwing,
      // so this catches only the storage path's exceptions.
      options.logger.error({ error: serializeError(error) }, "gift_catalog_refresh_threw");
    }
  };

  const schedule = (): void => {
    inFlight = tick();
  };

  // Kick off the first refresh immediately so the cache is warm when the
  // worker starts. Subsequent runs follow the cadence.
  schedule();
  const handle = setIntervalFn(schedule, options.intervalMs);

  return {
    stop: () => {
      clearIntervalFn(handle);
    },
    currentTick: () => inFlight,
  };
};

const serializeError = (error: unknown): Readonly<Record<string, unknown>> => {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { value: String(error) };
};
