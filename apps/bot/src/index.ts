import { Bot } from "grammy";
import { TtlFetchCache } from "@tonshield/safe-fetch";
import { createBasicScan } from "@tonshield/ton-scanner";
import { loadBotConfig } from "./config.ts";
import { formatScanReport, welcomeMessage } from "./messages.ts";

const config = loadBotConfig();
const bot = new Bot(config.token);
const manifestCache = new TtlFetchCache();

bot.command("start", async (context) => {
  await context.reply(welcomeMessage);
});

bot.command("help", async (context) => {
  await context.reply(welcomeMessage);
});

bot.on("message:text", async (context) => {
  const report = await createBasicScan({
    cache: manifestCache,
    rawInput: context.message.text,
  });

  await context.reply(formatScanReport(report), {
    link_preview_options: {
      is_disabled: true,
    },
  });
});

bot.catch((error) => {
  console.error("TON Shield bot error", error);
});

await bot.start({
  onStart: (botInfo) => {
    console.log(`TON Shield bot started as @${botInfo.username}`);
  },
});
