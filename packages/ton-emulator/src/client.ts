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
 * OPEN QUESTION FOR PR-B — `/v2/wallet/emulate` signature handling:
 *   `POST /v2/wallet/emulate` returns `MessageConsequences` (which includes
 *   the pre-computed `risk` summary we want), but unlike `/v2/traces/emulate`
 *   and `/v2/events/emulate` it does NOT expose `ignore_signature_check` in
 *   the current OpenAPI spec. It only takes `i18n` / `currency` query params
 *   plus an `EmulationBoc` body.
 *
 *   Two scenarios, to be verified empirically before committing PR-B:
 *     a) wallet-emulate implicitly handles unsigned messages signed with a
 *        dummy key (the contract's own signature check would fail, but TONAPI
 *        may bypass the check inside the wallet emulator). Then PR-B uses
 *        `/v2/wallet/emulate` directly.
 *     b) wallet-emulate requires a valid signature → drop to a two-call
 *        strategy: `/v2/traces/emulate?ignore_signature_check=true` for the
 *        action list (always works), and walk the trace ourselves to compute
 *        the equivalent of `risk.transfer_all_remaining_balance`, etc.
 *
 *   PR-B must run a smoke test against a real TONAPI key with both an
 *   uninitialised dummy-signed external message and a fresh transaction
 *   request before settling on the strategy.
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
