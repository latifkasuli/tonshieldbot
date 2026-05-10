import { TonApiClient } from "@ton-api/client";
import type { TonEmulatorConfig } from "./config.ts";

/**
 * Thin wrapper around `@ton-api/client`'s `TonApiClient`. We expose the
 * underlying client for now and layer our own typed methods on top in PR-B
 * (request builder) and PR-C (emulation scanner). Keeping this indirection
 * means the rest of the codebase imports from `@tonshield/ton-emulator`, not
 * directly from `@ton-api/client`, so swapping providers later (or adding a
 * Toncenter fallback per §18.3 of the spec) is a single-package change.
 */
export interface TonEmulatorClient {
  /** True iff the underlying TONAPI client is authenticated. */
  readonly enabled: boolean;
  /** The underlying SDK client. Use only inside this package. */
  readonly raw: TonApiClient;
  readonly baseUrl: string;
}

/**
 * Build a TON emulator client from validated config. Always returns a client;
 * `enabled` is false when no `TONAPI_KEY` was provided. Callers should branch
 * on `enabled` and short-circuit to static-only scanning when false.
 */
export const createTonEmulatorClient = (config: TonEmulatorConfig): TonEmulatorClient => {
  const raw = new TonApiClient(
    config.apiKey === null
      ? { baseUrl: config.baseUrl }
      : { baseUrl: config.baseUrl, apiKey: config.apiKey },
  );

  return {
    enabled: config.apiKey !== null,
    raw,
    baseUrl: config.baseUrl,
  };
};
