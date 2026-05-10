import type { ScanInput } from "@tonshield/shared";

/**
 * Whether a scan result is safe to serve from the report cache (input-hash
 * dedup) instead of running a fresh scan.
 *
 * Most scan kinds produce a deterministic result that's a pure function of
 * the input — the same TON Connect link, address, or BOC will keep yielding
 * the same findings indefinitely, so persisting and reusing those reports
 * is correct.
 *
 * The exception is `transaction_json` with TONAPI emulation enabled:
 * `/v2/wallet/emulate` runs against current blockchain state (the sender's
 * seqno, balance, code, and any contracts the message touches). Two
 * emulation calls of the same transaction at different times can legitimately
 * produce different `MessageConsequences`, so caching the first one as the
 * canonical answer would serve stale risk data.
 *
 * It also prevents a subtler "stuck-finding" bug: a transaction scanned
 * before `TONAPI_KEY` was configured would persist `EMULATION_NOT_CONFIGURED`
 * in the cache forever, and enabling the key on the running deployment
 * wouldn't trigger a re-scan. With this rule, enabling the key invalidates
 * the cache for transaction-JSON inputs immediately.
 */
export const isScanResultCacheable = (
  input: ScanInput,
  options: { readonly emulatorEnabled: boolean },
): boolean => {
  if (input.kind === "transaction_json" && options.emulatorEnabled) {
    return false;
  }

  return true;
};
