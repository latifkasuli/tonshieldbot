import { z } from "zod";

/**
 * Validated configuration for the TONAPI client.
 *
 * Resolution rules:
 *   - `TONAPI_KEY` is required to enable emulation. Without it, callers should
 *     run in M1.5-only mode (static decode) and surface
 *     `EMULATION_NOT_CONFIGURED` so the omission is visible in scan reports.
 *   - `TONAPI_BASE_URL` defaults to `https://tonapi.io`. Set to
 *     `https://testnet.tonapi.io` for testnet scans.
 */
const tonEmulatorEnvSchema = z.object({
  TONAPI_KEY: z.string().min(1).optional(),
  TONAPI_BASE_URL: z.url().default("https://tonapi.io"),
});

export interface TonEmulatorConfig {
  /** Bearer token from https://tonconsole.com. Absent means emulation is disabled. */
  readonly apiKey: string | null;
  readonly baseUrl: string;
}

export const loadTonEmulatorConfig = (env: NodeJS.ProcessEnv = process.env): TonEmulatorConfig => {
  const parsed = tonEmulatorEnvSchema.parse(env);

  return {
    apiKey: parsed.TONAPI_KEY ?? null,
    baseUrl: parsed.TONAPI_BASE_URL,
  };
};

/**
 * True when emulation can be performed. Callers should check this before
 * invoking emulation methods; when false, the scanner should fall back to
 * static-only mode and emit `EMULATION_NOT_CONFIGURED` (info).
 */
export const isEmulationEnabled = (config: TonEmulatorConfig): boolean => config.apiKey !== null;
