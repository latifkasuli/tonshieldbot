import { Bot } from "grammy";
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

type BotContext = Context & LoggerFlavor;

const config = loadBotConfig();
const deps = createBotDependencies(config);
const bot = new Bot<BotContext>(config.token);
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

await bot.start({
  onStart: (botInfo) => {
    deps.logger.info({ username: botInfo.username }, "bot_started");
  },
});
