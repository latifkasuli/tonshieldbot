import * as dns from "node:dns";
import { Bot, GrammyError, HttpError } from "grammy";
import type { Context } from "grammy";
import { createGrammyLogger } from "@tonshield/logger";
import type { LoggerFlavor } from "@tonshield/logger";
import { createGrammyRateLimit, defaultTierLimits } from "@tonshield/rate-limit";
import { TtlFetchCache } from "@tonshield/safe-fetch";
import { canonicalInputHash } from "@tonshield/storage";
import { classifyInput, createBasicScan, isScanResultCacheable } from "@tonshield/ton-scanner";
import { loadBotConfig } from "./config.ts";
import { createBotDependencies } from "./deps.ts";
import { formatScanReport, welcomeMessage } from "./messages.ts";

// Force IPv4-first DNS resolution. Railway's egress sometimes resolves
// `api.telegram.org` to an IPv6 address that doesn't have a working
// route back, which makes Node's native fetch (used by grammY) hang
// indefinitely on the first request — including the implicit `getMe()`
// inside `bot.start()`. The hang has no error, no log, no exit; the
// process just stops at the top-level `await`. Forcing IPv4 here
// avoids the unreachable AAAA records entirely. Cheap, no-op on
// platforms whose IPv6 actually works.
dns.setDefaultResultOrder("ipv4first");

const BOT_API_REQUEST_TIMEOUT_SECONDS = 20;
const BOT_LONG_POLL_TIMEOUT_SECONDS = 10;
const BOT_STARTUP_TIMEOUT_MS = 45_000;

type BotContext = Context & LoggerFlavor;

const config = loadBotConfig();
const deps = createBotDependencies(config);
const bot = new Bot<BotContext>(config.token, {
  client: {
    timeoutSeconds: BOT_API_REQUEST_TIMEOUT_SECONDS,
  },
});
const manifestCache = new TtlFetchCache();

bot.use(createGrammyLogger<BotContext>({ logger: deps.logger }));

bot.use(
  createGrammyRateLimit<BotContext>({
    limiter: deps.rateLimiter,
    tiers: defaultTierLimits,
    onLimit: async (ctx, decision) => {
      const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      ctx.log.warn({ retry_after_ms: decision.retryAfterMs }, "rate_limited");
      await ctx.reply(`You are sending requests too fast. Try again in ${String(seconds)}s.`);
    },
  }),
);

bot.command("start", async (ctx) => {
  await ctx.reply(welcomeMessage);
});

bot.command("help", async (ctx) => {
  await ctx.reply(welcomeMessage);
});

bot.on("message:text", async (ctx) => {
  const rawInput = ctx.message.text;
  const classified = classifyInput(rawInput);
  const inputHash = canonicalInputHash(classified);
  // Emulation runs against current blockchain state, so transaction-JSON
  // scans can't be safely served from cache when emulation is enabled —
  // see `isScanResultCacheable` for the full rationale.
  const cacheable = isScanResultCacheable(classified, {
    emulatorEnabled: deps.emulator.enabled,
    telegramIntelEnabled: deps.telegramIntel.enabled,
    fragmentEnabled: deps.fragment.enabled,
  });
  const cached = cacheable ? await deps.storage.reports.findByInputHash(inputHash) : null;

  let report;

  if (cached !== null) {
    ctx.log.info(
      { input_kind: cached.input.kind, verdict: cached.verdict, dedup_hit: true },
      "scan_resolved",
    );
    report = cached;
  } else {
    const fresh = await createBasicScan({
      cache: manifestCache,
      emulator: deps.emulator,
      telegramIntel: deps.telegramIntel,
      telegramEntities: deps.storage.telegramEntities,
      telegramGiftCatalog: deps.storage.telegramGiftCatalog,
      fragment: deps.fragment,
      fragmentCache: deps.fragmentCache,
      rawInput,
    });
    // `ReportStore.save()` is dedup-aware and returns the existing row on
    // input-hash conflict — symmetric with `findByInputHash` above. When
    // not cacheable, return the fresh report directly. See
    // `isScanResultCacheable` for the rationale.
    report = cacheable ? await deps.storage.reports.save(fresh) : fresh;
    ctx.log.info(
      {
        input_kind: report.input.kind,
        verdict: report.verdict,
        risk_score: report.riskScore,
        dedup_hit: cacheable && report.id !== fresh.id,
        persisted: cacheable,
      },
      "scan_resolved",
    );
  }

  await ctx.reply(formatScanReport(report), {
    link_preview_options: {
      is_disabled: true,
    },
  });
});

bot.catch((err) => {
  deps.logger.error({ err: err.error, request_id: err.ctx.requestId }, "bot_error");
});

const shutdown = async (signal: string): Promise<void> => {
  deps.logger.info({ signal }, "bot_shutting_down");
  await bot.stop();
  await deps.close();
  process.exit(0);
};

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

// Surface anything that escapes async boundaries. grammY puts its own
// errors through `bot.catch()`, but a stray rejection in middleware or
// during startup would otherwise vanish (no log, Node exits cleanly).
// Logging + exiting makes Railway's restart policy do the right thing.
process.on("uncaughtException", (err) => {
  deps.logger.fatal({ err }, "bot_uncaught_exception");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  deps.logger.fatal(
    { reason: reason instanceof Error ? { name: reason.name, message: reason.message } : reason },
    "bot_unhandled_rejection",
  );
  process.exit(1);
});

deps.logger.info({}, "bot_starting");

const startupWatchdog = setTimeout(() => {
  deps.logger.fatal(
    {
      timeout_ms: BOT_STARTUP_TIMEOUT_MS,
      request_timeout_seconds: BOT_API_REQUEST_TIMEOUT_SECONDS,
      long_poll_timeout_seconds: BOT_LONG_POLL_TIMEOUT_SECONDS,
      is_running: bot.isRunning(),
      is_inited: bot.isInited(),
    },
    "bot_start_timeout",
  );
  process.exit(1);
}, BOT_STARTUP_TIMEOUT_MS);
startupWatchdog.unref();

try {
  // grammY's `bot.start()` does this internally, but it wraps startup
  // calls in indefinite retry logic. Do an explicit preflight first so a
  // bad token or unreachable Telegram API fails under our shorter client
  // timeout and produces a precise deploy-log breadcrumb.
  const botInfo = await bot.api.getMe();
  bot.botInfo = botInfo;
  deps.logger.info({ id: botInfo.id, username: botInfo.username }, "bot_get_me_ok");

  await bot.start({
    timeout: BOT_LONG_POLL_TIMEOUT_SECONDS,
    onStart: (botInfo) => {
      clearTimeout(startupWatchdog);
      deps.logger.info({ username: botInfo.username }, "bot_started");
    },
  });
} catch (err) {
  clearTimeout(startupWatchdog);
  // Most likely culprit if this fires: the explicit `getMe()` preflight
  // or `deleteWebhook()` inside `bot.start()` failed (network / token
  // rejected / api.telegram.org reachability).
  // We log the structured failure so the deploy logs reveal the cause
  // instead of the previous silent hang. `GrammyError` carries
  // `error_code` + `description`; `HttpError` carries the underlying
  // transport `.error`.
  if (err instanceof GrammyError) {
    deps.logger.fatal(
      { error_code: err.error_code, description: err.description, method: err.method },
      "bot_start_grammy_error",
    );
  } else if (err instanceof HttpError) {
    deps.logger.fatal(
      { error: err.error instanceof Error ? err.error.message : String(err.error) },
      "bot_start_http_error",
    );
  } else {
    deps.logger.fatal({ err }, "bot_start_unknown_error");
  }
  process.exit(1);
}
