import type { Logger } from "@tonshield/logger";
import type { TelegramEntityStore } from "@tonshield/storage";

/**
 * Periodic snapshot retention. Deletes `telegram_entity_snapshots` rows
 * older than `retentionMs` past `now()`, capped at `maxRowsPerRun` rows
 * per tick. Matches the design doc decision #9: 365 days for
 * public-entity snapshots (the default; operators can override).
 *
 * Why a separate loop rather than reusing the gift-catalog refresh
 * cadence: retention is daily-grained (the catalog refresh is hourly),
 * and the per-call cost is much higher (a delete vs. a 50-row upsert).
 * Keeping them independent means one slow retention sweep can't starve
 * gift-catalog freshness.
 *
 * The loop pattern mirrors `refresh-loop.ts` — same testable schedule
 * injection, same swallowed-error behaviour (log + keep running).
 */

export interface RetentionLoopHandle {
  readonly stop: () => void;
  readonly currentTick: () => Promise<void>;
}

export interface StartRetentionLoopOptions {
  readonly store: TelegramEntityStore;
  readonly logger: Logger;
  readonly intervalMs: number;
  /** Retention window: rows older than `now - retentionMs` get deleted. */
  readonly retentionMs: number;
  /** Cap on rows deleted per tick. Bounds blast radius. */
  readonly maxRowsPerRun: number;
  /** Inject `setInterval` / `clearInterval` for tests. Defaults to globals. */
  readonly schedule?: {
    readonly setInterval: typeof setInterval;
    readonly clearInterval: typeof clearInterval;
  };
  readonly now?: () => Date;
}

export const startSnapshotRetentionLoop = (
  options: StartRetentionLoopOptions,
): RetentionLoopHandle => {
  const setIntervalFn = options.schedule?.setInterval ?? setInterval;
  const clearIntervalFn = options.schedule?.clearInterval ?? clearInterval;
  const now = options.now ?? (() => new Date());

  let inFlight: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    try {
      const cutoff = new Date(now().getTime() - options.retentionMs);
      const result = await options.store.pruneSnapshots({
        cutoff,
        maxRows: options.maxRowsPerRun,
      });
      options.logger.info(
        {
          deleted_count: result.deletedCount,
          cutoff: cutoff.toISOString(),
          max_rows_per_run: options.maxRowsPerRun,
          // If we hit the cap, the next tick will pick up the rest.
          // Surface this so operators can spot a backlog forming.
          capped: result.deletedCount >= options.maxRowsPerRun,
        },
        "snapshot_retention_run",
      );
    } catch (error) {
      options.logger.error({ error: serializeError(error) }, "snapshot_retention_threw");
    }
  };

  const schedule = (): void => {
    inFlight = tick();
  };

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
