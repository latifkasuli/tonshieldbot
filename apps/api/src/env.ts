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
});

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string | undefined;
  readonly redisUrl: string | undefined;
}

const DEFAULT_PORT = 3000;

export const loadApiConfig = (env: NodeJS.ProcessEnv = process.env): ApiConfig => {
  const parsed = envSchema.parse(env);

  return {
    host: parsed.API_HOST,
    port: parsed.API_PORT ?? parsed.PORT ?? DEFAULT_PORT,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
  };
};
