import { Bot } from "grammy";
import type { Context } from "grammy";
import { createGrammyLogger, createLogger } from "@tonshield/logger";
import type { LoggerFlavor } from "@tonshield/logger";
import { TtlFetchCache } from "@tonshield/safe-fetch";
import { createBasicScan } from "@tonshield/ton-scanner";
import { loadBotConfig } from "./config.ts";
import { formatScanReport, welcomeMessage } from "./messages.ts";

type BotContext = Context & LoggerFlavor;

const logger = createLogger({ service: "tonshield-bot" });
const config = loadBotConfig();
const bot = new Bot<BotContext>(config.token);
const manifestCache = new TtlFetchCache();

bot.use(createGrammyLogger<BotContext>({ logger }));

bot.command("start", async (ctx) => {
  await ctx.reply(welcomeMessage);
});

bot.command("help", async (ctx) => {
  await ctx.reply(welcomeMessage);
});

bot.on("message:text", async (ctx) => {
  const report = await createBasicScan({
    cache: manifestCache,
    rawInput: ctx.message.text,
  });

  ctx.log.info(
    { verdict: report.verdict, risk_score: report.riskScore, input_kind: report.input.kind },
    "scan_completed",
  );

  await ctx.reply(formatScanReport(report), {
    link_preview_options: {
      is_disabled: true,
    },
  });
});

bot.catch((err) => {
  // Errors that escape the per-update logger middleware land here. The
  // grammy ErrorHandler exposes the original update on err.ctx so we can
  // still tag the log with whatever request_id the middleware assigned.
  // err.ctx is already typed as BotContext via the Bot<BotContext> generic,
  // so the requestId field is in scope without a cast.
  logger.error({ err: err.error, request_id: err.ctx.requestId }, "bot_error");
});

await bot.start({
  onStart: (botInfo) => {
    logger.info({ username: botInfo.username }, "bot_started");
  },
});
