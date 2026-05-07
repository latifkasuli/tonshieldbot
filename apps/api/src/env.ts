import { z } from "zod";

const envSchema = z.object({
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3000),
});

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
}

export const loadApiConfig = (): ApiConfig => {
  const parsed = envSchema.parse(process.env);

  return {
    host: parsed.API_HOST,
    port: parsed.API_PORT,
  };
};
