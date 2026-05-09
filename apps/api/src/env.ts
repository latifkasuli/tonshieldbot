import { z } from "zod";

const envSchema = z.object({
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().optional(),
  // Railway and most PaaS providers inject PORT. Honored as a fallback so we
  // can deploy without remapping env vars; explicit API_PORT still wins.
  PORT: z.coerce.number().int().positive().optional(),
});

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
}

const DEFAULT_PORT = 3000;

export const loadApiConfig = (env: NodeJS.ProcessEnv = process.env): ApiConfig => {
  const parsed = envSchema.parse(env);

  return {
    host: parsed.API_HOST,
    port: parsed.API_PORT ?? parsed.PORT ?? DEFAULT_PORT,
  };
};
