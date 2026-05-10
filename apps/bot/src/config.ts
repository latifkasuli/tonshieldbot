import { z } from "zod";

const botConfigSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  // M2 emulation env. See apps/api/src/env.ts for matching docs — both
  // services use the same TONAPI key when emulation is enabled.
  TONAPI_KEY: z.string().optional(),
  TONAPI_BASE_URL: z.string().optional(),
  // M3 Telegram intelligence base URL override (typically only set when
  // self-hosting a local Bot API server). The token itself reuses
  // BOT_TOKEN — the long-polling UI bot and the intel client share one
  // Bot API identity per the §9 Q1 decision in m3-design.md.
  TELEGRAM_API_BASE_URL: z.string().optional(),
});

export interface BotConfig {
  readonly token: string;
  readonly databaseUrl: string | undefined;
  readonly redisUrl: string | undefined;
  readonly tonApiKey: string | undefined;
  readonly tonApiBaseUrl: string | undefined;
  readonly telegramApiBaseUrl: string | undefined;
}

export const loadBotConfig = (env: NodeJS.ProcessEnv = process.env): BotConfig => {
  const parsed = botConfigSchema.parse(env);

  return {
    token: parsed.BOT_TOKEN,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    tonApiKey: parsed.TONAPI_KEY,
    tonApiBaseUrl: parsed.TONAPI_BASE_URL,
    telegramApiBaseUrl: parsed.TELEGRAM_API_BASE_URL,
  };
};
