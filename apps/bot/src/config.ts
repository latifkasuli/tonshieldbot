import { z } from "zod";

const botConfigSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
});

export interface BotConfig {
  readonly token: string;
}

export const loadBotConfig = (): BotConfig => {
  const parsed = botConfigSchema.parse(process.env);

  return {
    token: parsed.BOT_TOKEN,
  };
};
