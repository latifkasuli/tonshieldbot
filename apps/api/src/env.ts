import { z } from "zod";

const envSchema = z.object({
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().optional(),
  // Railway and most PaaS providers inject PORT. Honored as a fallback so we
  // can deploy without remapping env vars; explicit API_PORT still wins.
  PORT: z.coerce.number().int().positive().optional(),
  // When set, scan results persist to Postgres and the api dedupes
  // identical inputs across requests. Unset → in-memory storage,
  // suitable for tests and local development only.
  DATABASE_URL: z.string().optional(),
  // When set, rate limiting uses Redis so all api instances share the
  // same buckets. Unset → in-memory rate limiter (single-process only).
  REDIS_URL: z.string().optional(),
  // When set, transaction-JSON scans get a live TONAPI emulation pass
  // (M2 / spec §9.3). Unset → static-decode-only reports plus an
  // `EMULATION_NOT_CONFIGURED` finding so the omission is visible.
  TONAPI_KEY: z.string().optional(),
  // Override the TONAPI base URL — typically only set on testnet
  // deployments (`https://testnet.tonapi.io`). Defaults to mainnet.
  TONAPI_BASE_URL: z.string().optional(),
  // When set, Telegram-side scans (M3 / spec §11) get live Bot API
  // enrichment. This is intentionally separate from apps/bot's BOT_TOKEN
  // so the scanner identity and operational budget are isolated. Unset →
  // static-only Telegram scanning plus a
  // `TELEGRAM_BOT_API_NOT_CONFIGURED` finding so the omission is visible.
  TELEGRAM_INTEL_BOT_TOKEN: z.string().optional(),
  // Override the Telegram Bot API base URL. Typically only set when
  // self-hosting a local Bot API server per
  // <https://core.telegram.org/bots/api#using-a-local-bot-api-server>.
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

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
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

const DEFAULT_PORT = 3000;

export const loadApiConfig = (env: NodeJS.ProcessEnv = process.env): ApiConfig => {
  const parsed = envSchema.parse(env);

  return {
    host: parsed.API_HOST,
    port: parsed.API_PORT ?? parsed.PORT ?? DEFAULT_PORT,
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
