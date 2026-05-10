import { z } from "zod";

/**
 * Validated configuration for the Telegram Bot API client.
 *
 * Resolution rules (per docs/research/m3-design.md §9 Q1, revised 2026-05-10):
 *   - `TELEGRAM_BOT_TOKEN` is required to enable any Bot API reads. Without
 *     it, callers should run in static-only mode and surface
 *     `TELEGRAM_BOT_API_NOT_CONFIGURED` so the omission is visible in scan
 *     reports.
 *   - The same token already powers `apps/bot`'s long-polling UI bot. We
 *     intentionally do NOT register a separate intel-only bot — read
 *     endpoints (`getChat`, `getUserGifts`, `getChatGifts`, `getAvailableGifts`)
 *     are not subject to the per-bot messaging caps, so a single token does
 *     both jobs without budget contention. Splitting tokens later is a
 *     one-PR config flag if operational reasons emerge.
 *   - `TELEGRAM_API_BASE_URL` defaults to `https://api.telegram.org`. Set to
 *     a local Bot API server URL when self-hosting per
 *     <https://core.telegram.org/bots/api#using-a-local-bot-api-server>.
 *
 * This loader is for STANDALONE use (e.g. scripts, tests). Within the
 * monorepo, `apps/bot` sources the token from its existing `BOT_TOKEN` env
 * and passes it explicitly via `createTelegramIntelClient({ token })`, so
 * there is no need for the bot to set a second env var. `apps/api` adds a
 * new `TELEGRAM_BOT_TOKEN` env var in its own loader; in production it is
 * set to the same value as the bot's `BOT_TOKEN`.
 */
const telegramIntelEnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_API_BASE_URL: z.url().default("https://api.telegram.org"),
});

export interface TelegramIntelConfig {
  /**
   * Bot API token (the long string from BotFather, e.g.
   * `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`). When `null`, the client is
   * disabled and all read paths short-circuit to
   * `TELEGRAM_BOT_API_NOT_CONFIGURED`.
   */
  readonly token: string | null;
  /** Bot API base URL, no trailing slash. Default `https://api.telegram.org`. */
  readonly apiBaseUrl: string;
}

export const loadTelegramIntelConfig = (
  env: NodeJS.ProcessEnv = process.env,
): TelegramIntelConfig => {
  const parsed = telegramIntelEnvSchema.parse(env);

  return {
    token: parsed.TELEGRAM_BOT_TOKEN ?? null,
    apiBaseUrl: parsed.TELEGRAM_API_BASE_URL,
  };
};

/**
 * True when Bot API reads can be performed. Callers should check this before
 * invoking any client method; when false, surface `TELEGRAM_BOT_API_NOT_CONFIGURED`.
 */
export const isTelegramIntelEnabled = (config: TelegramIntelConfig): boolean =>
  config.token !== null;
