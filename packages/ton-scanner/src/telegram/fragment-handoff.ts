import { createFinding, getCoreRule } from "@tonshield/risk-engine";
import type { RiskFinding } from "@tonshield/shared";
import {
  lookupUsernameOwnership,
  type FragmentIntelClient,
  type OwnershipCache,
  type UsernameOwnershipResult,
} from "@tonshield/fragment-intel";

/**
 * Fires `TELEGRAM_USERNAME_FRAGMENT_HANDOFF` when the candidate
 * Telegram username has a Fragment NFT whose most recent on-chain
 * transfer falls inside the "recently changed" window.
 *
 * Health rules are emitted distinctly so the user sees the difference
 * between "Fragment lookup didn't run" (FRAGMENT_API_NOT_CONFIGURED,
 * info) and "Fragment lookup tried and failed" (FRAGMENT_API_UNAVAILABLE,
 * low). `not_found` (no DNS record / non-Fragment username) returns no
 * findings — that's the expected outcome for the vast majority of
 * scanned handles.
 *
 * Deduplication: the cache (when provided) absorbs repeated lookups
 * for the same username within a single request burst. The caller is
 * also expected to dedupe `inputHandle` vs `resolved entity username`
 * upstream so we don't double-emit for the same scan.
 */

export type FragmentHandoffEvent =
  | { readonly kind: "finding"; readonly finding: RiskFinding }
  | { readonly kind: "not_found" }
  | { readonly kind: "no_username" }
  | { readonly kind: "no_recent_transfer" };

export interface FragmentHandoffOptions {
  /**
   * Lookback window for "recent". Default 30 days. The rule fires when
   * the most recent on-chain NftItemTransfer's timestamp is within this
   * window relative to `now`.
   */
  readonly recentWindowMs?: number;
  /** Inject `now()` for tests. Defaults to `Date.now`. */
  readonly now?: () => Date;
  /** Optional cache shared across a scan / request burst. */
  readonly cache?: OwnershipCache;
}

const DEFAULT_RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Run the Fragment handoff check for a single candidate username.
 * Returns a list of findings to merge into the scan result. The list
 * is always 0 or 1 entries — the rule fires at most once per
 * invocation.
 */
export const checkFragmentHandoff = async (
  client: FragmentIntelClient | undefined,
  candidate: string | null,
  options: FragmentHandoffOptions = {},
): Promise<readonly RiskFinding[]> => {
  if (candidate === null) return [];
  const cleaned = candidate.replace(/^@/, "").trim().toLowerCase();
  if (cleaned.length === 0) return [];

  if (client === undefined) {
    return [healthFinding("TELEGRAM_FRAGMENT_API_NOT_CONFIGURED")];
  }
  if (!client.enabled) {
    return [healthFinding("TELEGRAM_FRAGMENT_API_NOT_CONFIGURED")];
  }

  const cached = options.cache?.get(cleaned) ?? null;
  const result: UsernameOwnershipResult =
    cached ??
    (await lookupUsernameOwnership(client, cleaned, options.now ? { now: options.now } : {}));
  if (cached === null) {
    options.cache?.set(cleaned, result);
  }

  if (result.status === "disabled") {
    return [healthFinding("TELEGRAM_FRAGMENT_API_NOT_CONFIGURED")];
  }
  if (result.status === "not_found") {
    return [];
  }
  if (result.status === "failed") {
    return [
      createFinding({
        confidence: "low",
        evidence: {
          username: cleaned,
          failure: result.failure,
        },
        rule: getCoreRule("TELEGRAM_FRAGMENT_API_UNAVAILABLE"),
      }),
    ];
  }

  // result.status === "ok"
  const { ownership } = result;
  if (ownership.lastTransferAt === null) return [];

  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const windowMs = options.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
  const transferMs = ownership.lastTransferAt * 1000;
  if (nowMs - transferMs > windowMs) return [];

  const ageDays = Math.max(0, Math.floor((nowMs - transferMs) / (24 * 60 * 60 * 1000)));

  return [
    createFinding({
      confidence: ageDays <= 7 ? "high" : "medium",
      evidence: {
        username: cleaned,
        nftAddress: ownership.nftAddress,
        ...(ownership.currentOwnerAddress === null
          ? {}
          : { currentOwnerAddress: ownership.currentOwnerAddress }),
        ...(ownership.previousOwnerAddress === null
          ? {}
          : { previousOwnerAddress: ownership.previousOwnerAddress }),
        lastTransferAt: new Date(transferMs).toISOString(),
        ageDays,
        recentWindowDays: Math.floor(windowMs / (24 * 60 * 60 * 1000)),
      },
      rule: getCoreRule("TELEGRAM_USERNAME_FRAGMENT_HANDOFF"),
    }),
  ];
};

const healthFinding = (
  ruleId: "TELEGRAM_FRAGMENT_API_NOT_CONFIGURED" | "TELEGRAM_FRAGMENT_API_UNAVAILABLE",
): RiskFinding =>
  createFinding({
    confidence: "low",
    evidence: {},
    rule: getCoreRule(ruleId),
  });
