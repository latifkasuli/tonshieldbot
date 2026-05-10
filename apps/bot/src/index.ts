import { Bot } from "grammy";
import type { Context } from "grammy";
import { createGrammyLogger } from "@tonshield/logger";
import type { LoggerFlavor } from "@tonshield/logger";
import { createGrammyRateLimit, defaultTierLimits } from "@tonshield/rate-limit";
import { TtlFetchCache } from "@tonshield/safe-fetch";
import { canonicalInputHash } from "@tonshield/storage";
import { classifyInput, createBasicScan } from "@tonshield/ton-scanner";
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
  const cached = await deps.storage.reports.findByInputHash(inputHash);

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
      rawInput,
    });
    report = await deps.storage.reports.save(fresh);
    ctx.log.info(
      {
        input_kind: report.input.kind,
        verdict: report.verdict,
        risk_score: report.riskScore,
        dedup_hit: report.id !== fresh.id,
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
