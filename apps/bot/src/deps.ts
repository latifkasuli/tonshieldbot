import { Redis } from "ioredis";
import { createLogger } from "@tonshield/logger";
import type { Logger } from "@tonshield/logger";
import { createInMemoryRateLimiter, createRedisRateLimiter } from "@tonshield/rate-limit";
import type { RateLimiter } from "@tonshield/rate-limit";
import { createStorage } from "@tonshield/storage";
import type { Storage } from "@tonshield/storage";
import type { BotConfig } from "./config.ts";

export interface BotDependencies {
  readonly logger: Logger;
  readonly storage: Storage;
  readonly rateLimiter: RateLimiter;
  readonly redis: Redis | null;
  readonly close: () => Promise<void>;
}

export const createBotDependencies = (config: BotConfig): BotDependencies => {
  const logger = createLogger({ service: "tonshield-bot" });
  const storage = createStorage(
    config.databaseUrl === undefined ? {} : { databaseUrl: config.databaseUrl },
  );

  let redis: Redis | null = null;
  let rateLimiter: RateLimiter;

  if (config.redisUrl !== undefined && config.redisUrl.length > 0) {
    redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
    rateLimiter = createRedisRateLimiter({ redis, keyPrefix: "rl:bot:" });
    logger.info({ backend: "redis" }, "rate_limiter_initialized");
  } else {
    rateLimiter = createInMemoryRateLimiter();
    logger.info({ backend: "memory" }, "rate_limiter_initialized");
  }

  logger.info(
    { storage: config.databaseUrl === undefined ? "memory" : "postgres" },
    "storage_initialized",
  );

  return {
    logger,
    storage,
    rateLimiter,
    redis,
    close: async () => {
      await storage.close();
      if (redis !== null) {
        await redis.quit();
      }
    },
  };
};
