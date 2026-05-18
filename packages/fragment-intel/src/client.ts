import { TonApiClient } from "@ton-api/client";
import type { FragmentIntelConfig } from "./config.ts";

/**
 * Thin wrapper around `@ton-api/client`'s `TonApiClient` for Fragment
 * intel lookups. Mirrors the shape of `@tonshield/ton-emulator`'s
 * client — same SDK, same TONAPI credentials, but a separate instance
 * so the package boundary stays clean. If we later want a single shared
 * client across packages, the abstraction can collapse without
 * touching call sites.
 *
 * `enabled` is the load-bearing flag: when false, callers must NOT call
 * lookup methods and should instead emit `FRAGMENT_API_NOT_CONFIGURED`.
 */
export interface FragmentIntelClient {
  /** True iff the underlying TONAPI client is authenticated. */
  readonly enabled: boolean;
  /** The underlying SDK client. Use only inside this package. */
  readonly raw: TonApiClient;
  /** Configured base URL — used for evidence breadcrumbs in failure findings. */
  readonly baseUrl: string;
}

export const createFragmentIntelClient = (config: FragmentIntelConfig): FragmentIntelClient => {
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
