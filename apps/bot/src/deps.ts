import { Redis } from "ioredis";
import {
  createFragmentIntelClient,
  createOwnershipCache,
  type FragmentIntelClient,
  type OwnershipCache,
} from "@tonshield/fragment-intel";
import { createLogger } from "@tonshield/logger";
import type { Logger } from "@tonshield/logger";
import { createInMemoryRateLimiter, createRedisRateLimiter } from "@tonshield/rate-limit";
import type { RateLimiter } from "@tonshield/rate-limit";
import { createStorage } from "@tonshield/storage";
import type { Storage } from "@tonshield/storage";
import { createTelegramIntelClient } from "@tonshield/telegram-intel";
import { createMtprotoIntelClient } from "@tonshield/telegram-intel/mtproto";
import type { TelegramIntelClient } from "@tonshield/telegram-intel";
import type { MtprotoIntelClient } from "@tonshield/telegram-intel/mtproto";
import { createTonEmulatorClient } from "@tonshield/ton-emulator";
import type { TonEmulatorClient } from "@tonshield/ton-emulator";
import type { BotConfig } from "./config.ts";

export interface BotDependencies {
  readonly logger: Logger;
  readonly storage: Storage;
  readonly rateLimiter: RateLimiter;
  readonly redis: Redis | null;
  readonly emulator: TonEmulatorClient;
  /**
   * Telegram Bot API client for M3 intelligence. Uses the optional
   * TELEGRAM_INTEL_BOT_TOKEN so the scanner identity stays separate from
   * the long-polling UI bot. When unset, scanners emit
   * TELEGRAM_BOT_API_NOT_CONFIGURED instead of attempting Bot API calls.
   */
  readonly telegramIntel: TelegramIntelClient;
  /** Optional MTProto fallback for cold public username resolution. */
  readonly mtprotoIntel: MtprotoIntelClient;
  /** Fragment intel client (PR-36) — on-chain username NFT lookups. */
  readonly fragment: FragmentIntelClient;
  /** Process-wide TTL cache for Fragment ownership lookups. */
  readonly fragmentCache: OwnershipCache;
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

  const emulator = createTonEmulatorClient({
    apiKey: config.tonApiKey ?? null,
    baseUrl: config.tonApiBaseUrl ?? "https://tonapi.io",
  });

  logger.info({ enabled: emulator.enabled, baseUrl: emulator.baseUrl }, "emulator_initialized");

  const telegramIntel = createTelegramIntelClient({
    token: config.telegramIntelBotToken ?? null,
    apiBaseUrl: config.telegramApiBaseUrl ?? "https://api.telegram.org",
  });
  const mtprotoIntel = createMtprotoIntelClient({
    apiId: config.telegramMtprotoApiId ?? null,
    apiHash: config.telegramMtprotoApiHash ?? null,
    botToken: config.telegramMtprotoBotToken ?? config.telegramIntelBotToken ?? null,
    session: config.telegramMtprotoSession ?? null,
  });

  logger.info(
    { enabled: telegramIntel.enabled, baseUrl: telegramIntel.apiBaseUrl },
    "telegram_intel_initialized",
  );
  logger.info(
    { enabled: mtprotoIntel.enabled, authMode: mtprotoIntel.authMode },
    "telegram_mtproto_intel_initialized",
  );

  const fragment = createFragmentIntelClient({
    apiKey: config.tonApiKey ?? null,
    baseUrl: config.tonApiBaseUrl ?? "https://tonapi.io",
  });
  const fragmentCache = createOwnershipCache();

  logger.info(
    { enabled: fragment.enabled, baseUrl: fragment.baseUrl },
    "fragment_intel_initialized",
  );

  return {
    logger,
    storage,
    rateLimiter,
    redis,
    emulator,
    telegramIntel,
    mtprotoIntel,
    fragment,
    fragmentCache,
    close: async () => {
      await mtprotoIntel.close();
      await storage.close();
      if (redis !== null) {
        await redis.quit();
      }
    },
  };
};
