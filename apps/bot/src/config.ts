import { z } from "zod";

const botConfigSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
});

export interface BotConfig {
  readonly token: string;
  readonly databaseUrl: string | undefined;
  readonly redisUrl: string | undefined;
}

export const loadBotConfig = (env: NodeJS.ProcessEnv = process.env): BotConfig => {
  const parsed = botConfigSchema.parse(env);

  return {
    token: parsed.BOT_TOKEN,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
  };
};
