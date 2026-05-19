import { z } from "zod";

const botConfigSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  // M2 emulation env. See apps/api/src/env.ts for matching docs — both
  // services use the same TONAPI key when emulation is enabled.
  TONAPI_KEY: z.string().optional(),
  TONAPI_BASE_URL: z.string().optional(),
  // Optional M3 Telegram intelligence token. Separate from BOT_TOKEN so the
  // user-facing bot and scanner/intel identity remain isolated.
  TELEGRAM_INTEL_BOT_TOKEN: z.string().optional(),
  // M3 Telegram intelligence base URL override (typically only set when
  // self-hosting a local Bot API server).
  TELEGRAM_API_BASE_URL: z.string().optional(),
  // Optional MTProto username resolver. Requires an api_id/api_hash from
  // https://my.telegram.org/apps. If TELEGRAM_MTPROTO_BOT_TOKEN is absent,
  // deps reuse TELEGRAM_INTEL_BOT_TOKEN for bot-auth MTProto login.
  TELEGRAM_MTPROTO_API_ID: z.coerce.number().int().positive().optional(),
  TELEGRAM_MTPROTO_API_HASH: z.string().min(1).optional(),
  TELEGRAM_MTPROTO_BOT_TOKEN: z.string().min(1).optional(),
  // Advanced: pre-authenticated GramJS StringSession. Prefer bot-token auth
  // unless a user session is explicitly needed and reviewed.
  TELEGRAM_MTPROTO_SESSION: z.string().min(1).optional(),
});

export interface BotConfig {
  readonly token: string;
  readonly databaseUrl: string | undefined;
  readonly redisUrl: string | undefined;
  readonly tonApiKey: string | undefined;
  readonly tonApiBaseUrl: string | undefined;
  readonly telegramIntelBotToken: string | undefined;
  readonly telegramApiBaseUrl: string | undefined;
  readonly telegramMtprotoApiId: number | undefined;
  readonly telegramMtprotoApiHash: string | undefined;
  readonly telegramMtprotoBotToken: string | undefined;
  readonly telegramMtprotoSession: string | undefined;
}

export const loadBotConfig = (env: NodeJS.ProcessEnv = process.env): BotConfig => {
  const parsed = botConfigSchema.parse(env);

  return {
    token: parsed.BOT_TOKEN,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    tonApiKey: parsed.TONAPI_KEY,
    tonApiBaseUrl: parsed.TONAPI_BASE_URL,
    telegramIntelBotToken: parsed.TELEGRAM_INTEL_BOT_TOKEN,
    telegramApiBaseUrl: parsed.TELEGRAM_API_BASE_URL,
    telegramMtprotoApiId: parsed.TELEGRAM_MTPROTO_API_ID,
    telegramMtprotoApiHash: parsed.TELEGRAM_MTPROTO_API_HASH,
    telegramMtprotoBotToken: parsed.TELEGRAM_MTPROTO_BOT_TOKEN,
    telegramMtprotoSession: parsed.TELEGRAM_MTPROTO_SESSION,
  };
};
