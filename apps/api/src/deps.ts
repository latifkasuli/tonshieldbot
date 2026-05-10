import { Redis } from "ioredis";
import { createLogger } from "@tonshield/logger";
import type { Logger } from "@tonshield/logger";
import { createInMemoryRateLimiter, createRedisRateLimiter } from "@tonshield/rate-limit";
import type { RateLimiter } from "@tonshield/rate-limit";
import { createStorage } from "@tonshield/storage";
import type { Storage } from "@tonshield/storage";
import { createTonEmulatorClient } from "@tonshield/ton-emulator";
import type { TonEmulatorClient } from "@tonshield/ton-emulator";
import type { ApiConfig } from "./env.ts";

export interface ApiDependencies {
  readonly logger: Logger;
  readonly storage: Storage;
  readonly rateLimiter: RateLimiter;
  readonly redis: Redis | null;
  /**
   * TONAPI client for M2 emulation. Always present — when no `TONAPI_KEY`
   * was set, `client.enabled` is false and the scanner emits
   * `EMULATION_NOT_CONFIGURED` instead of trying any HTTP calls.
   */
  readonly emulator: TonEmulatorClient;
  readonly close: () => Promise<void>;
}

/**
 * Builds the app's dependency graph from validated config.
 *
 * Storage and rate limiter are env-driven: `DATABASE_URL` switches
 * storage to Postgres, `REDIS_URL` switches the rate limiter to Redis.
 * Either or both may be unset for local dev — the app still boots with
 * in-memory backends.
 */
export const createApiDependencies = (config: ApiConfig): ApiDependencies => {
  const logger = createLogger({ service: "tonshield-api" });
  const storage = createStorage(
    config.databaseUrl === undefined ? {} : { databaseUrl: config.databaseUrl },
  );

  let redis: Redis | null = null;
  let rateLimiter: RateLimiter;

  if (config.redisUrl !== undefined && config.redisUrl.length > 0) {
    redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
    rateLimiter = createRedisRateLimiter({ redis });
    logger.info({ backend: "redis" }, "rate_limiter_initialized");
  } else {
    rateLimiter = createInMemoryRateLimiter();
    logger.info({ backend: "memory" }, "rate_limiter_initialized");
  }

  logger.info(
    { storage: config.databaseUrl === undefined ? "memory" : "postgres" },
    "storage_initialized",
  );

  const emulator = createTonEmulatorClient({
    apiKey: config.tonApiKey ?? null,
    baseUrl: config.tonApiBaseUrl ?? "https://tonapi.io",
  });

  logger.info({ enabled: emulator.enabled, baseUrl: emulator.baseUrl }, "emulator_initialized");

  return {
    logger,
    storage,
    rateLimiter,
    redis,
    emulator,
    close: async () => {
      await storage.close();
      if (redis !== null) {
        await redis.quit();
      }
    },
  };
};
