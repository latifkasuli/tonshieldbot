import type { ScanInput } from "@tonshield/shared";

/**
 * Whether a scan result is safe to participate in the input-hash-keyed
 * report cache. This governs **both ends** of the cache lifecycle:
 *
 *   - `findByInputHash()` lookups (read side): when false, callers should
 *     skip the cache and run a fresh scan.
 *   - `ReportStore.save()` (write side): `save()` is dedup-aware — it
 *     returns the existing row on input-hash conflict instead of writing.
 *     When this returns false, callers must NOT call `save(fresh)`, or the
 *     stale stored report will silently replace the fresh emulation result
 *     they just produced. Return `fresh` directly instead.
 *
 * Most scan kinds produce a deterministic result that's a pure function of
 * the input — the same TON Connect link, address, or BOC will keep yielding
 * the same findings indefinitely, so persisting and reusing those reports
 * is correct.
 *
 * The exception is `transaction_json` and `boc` with TONAPI emulation enabled.
 * Both paths run TONAPI emulation against current blockchain state (the
 * sender's seqno, balance, code, and any contracts the message touches).
 * Two emulation calls of the same input at different times can legitimately
 * produce different action lists / is_scam flags, so caching the first one
 * as the canonical answer would serve stale risk data.
 *
 * This also prevents a subtler "stuck-finding" bug: an input scanned before
 * `TONAPI_KEY` was configured would persist `EMULATION_NOT_CONFIGURED` in
 * the cache forever, and enabling the key on the running deployment
 * wouldn't trigger a re-scan. With this rule, enabling the key invalidates
 * the cache for both emulated input kinds immediately on both sides.
 */
export const isScanResultCacheable = (
  input: ScanInput,
  options: { readonly emulatorEnabled: boolean },
): boolean => {
  if ((input.kind === "transaction_json" || input.kind === "boc") && options.emulatorEnabled) {
    return false;
  }

  return true;
};
