import { z } from "zod";

/**
 * Validated configuration for Fragment intel. Wraps the same TONAPI
 * credentials the emulator uses — Fragment lookups go through TONAPI's
 * DNS + NFT endpoints, so a single `TONAPI_KEY` covers both surfaces.
 *
 * The wrapper exists so callers can branch on `enabled` without
 * importing the emulator's config. Future work may move both subsystems
 * onto a shared TONAPI client, but for PR-36 the two clients are
 * independent instances over the same env vars.
 */
const fragmentIntelEnvSchema = z.object({
  TONAPI_KEY: z.string().min(1).optional(),
  TONAPI_BASE_URL: z.url().default("https://tonapi.io"),
});

export interface FragmentIntelConfig {
  /** Bearer token from https://tonconsole.com. Absent means Fragment lookups are disabled. */
  readonly apiKey: string | null;
  readonly baseUrl: string;
}

export const loadFragmentIntelConfig = (
  env: NodeJS.ProcessEnv = process.env,
): FragmentIntelConfig => {
  const parsed = fragmentIntelEnvSchema.parse(env);
  return {
    apiKey: parsed.TONAPI_KEY ?? null,
    baseUrl: parsed.TONAPI_BASE_URL,
  };
};

/**
 * True when Fragment ownership lookups can be performed. Callers should
 * check this before invoking lookup methods; when false, scanners should
 * emit `FRAGMENT_API_NOT_CONFIGURED` (info) so the omission is visible.
 */
export const isFragmentIntelEnabled = (config: FragmentIntelConfig): boolean =>
  config.apiKey !== null;
