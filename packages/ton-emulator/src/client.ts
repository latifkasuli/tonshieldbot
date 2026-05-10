import { TonApiClient } from "@ton-api/client";
import type { TonEmulatorConfig } from "./config.ts";

/**
 * Thin wrapper around `@ton-api/client`'s `TonApiClient`. We expose the
 * underlying client for now and layer our own typed methods on top in PR-B
 * (request builder) and PR-C (emulation scanner). Keeping this indirection
 * means the rest of the codebase imports from `@tonshield/ton-emulator`, not
 * directly from `@ton-api/client`, so swapping providers later (or adding a
 * Toncenter fallback per §18.3 of the spec) is a single-package change.
 *
 * RESOLVED IN PR-B — `/v2/wallet/emulate` signature handling:
 *   The PR-A scaffold flagged uncertainty about whether `/v2/wallet/emulate`
 *   would tolerate dummy-key-signed external messages, since the endpoint
 *   does not expose `ignore_signature_check` in the OpenAPI. PR-B's empirical
 *   smoke test (against a real, on-chain V4R2 wallet, captured in the PR
 *   description) showed:
 *
 *     - `POST /v2/wallet/emulate` with a dummy-key-signed external message
 *       returns HTTP 200 and the full `MessageConsequences { trace, risk,
 *       event }` object. TONAPI's emulator silently bypasses the wallet's
 *       internal signature check for emulation purposes.
 *     - `POST /v2/traces/emulate` returns 200 with or without
 *       `ignore_signature_check=true`, suggesting the flag is mainly defensive
 *       for non-wallet contracts that have their own signature logic.
 *
 *   PR-C therefore calls `/v2/wallet/emulate` directly when the sender is a
 *   detected wallet contract (V3R2 / V4R2 / V5R1) and consumes the
 *   pre-computed `risk` object as documented.
 *
 *   Trace-emulate is kept as a fallback for §9.3.4 (raw BOC inputs and
 *   non-wallet senders), which PR-D handles.
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
