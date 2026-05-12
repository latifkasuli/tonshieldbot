import { createFinding, getCoreRule } from "@tonshield/risk-engine";
import type { ActionPreview, RiskFinding } from "@tonshield/shared";
import type { FetchCache } from "@tonshield/safe-fetch";
import { safeFetch } from "@tonshield/safe-fetch";
import {
  parseGiftPage,
  type GiftLinkNotVerifiedReason,
  type GiftLinkResolution,
} from "@tonshield/telegram-intel";

/**
 * Scanner for `t.me/nft/<slug>` Telegram-collectible references. Fetches
 * the public gift page via `safeFetch` and runs the pure
 * `parseGiftPage` resolver to decide whether the slug actually points at
 * a live collectible.
 *
 * Resolution outcomes:
 *
 *   - `verified` — page contains `<meta property="al:ios:url" content="tg://nft?slug=<expected>">`
 *     and the canonical slug matches the submitted one. We return an
 *     informational `ActionPreview` carrying the gift metadata (title,
 *     gift name, collectible number, model/backdrop/symbol attributes,
 *     image URL) so the user sees the gift details. No finding is
 *     emitted — verification is the absence of a problem signal, not
 *     a positive attestation that the GIFT INSTANCE is legitimate. Per
 *     PR-6's scope: verifying the slug resolves ≠ verifying the
 *     publisher; the latter ships in PR-8 with owned-gift inventory.
 *
 *   - `not_verified` — emit `TELEGRAM_GIFT_LINK_NOT_VERIFIED` with the
 *     specific reason in evidence so the user can disambiguate
 *     "doesn't exist" from "redirected to a different slug" (the
 *     stronger fraud signal).
 *
 *   - Fetch failure — emit `TELEGRAM_GIFT_LINK_NOT_VERIFIED` with
 *     `reason: "non_gift_page"` and a `fetchError` in evidence. We do
 *     NOT silently degrade like the Mini App scanner because users
 *     expect a verdict on a specifically-submitted gift link — silence
 *     would look like "the gift is fine".
 */

export interface GiftScanResult {
  readonly findings: readonly RiskFinding[];
  readonly actions: readonly ActionPreview[];
}

/**
 * Fetch the Telegram public gift page for a `telegram_nft_link` input
 * and decide whether the slug resolves. The caller (basic-scan.ts)
 * supplies the optional fetch cache for repeat scans of the same slug.
 */
export const scanGiftLink = async (
  url: URL,
  slug: string,
  cache?: FetchCache,
): Promise<GiftScanResult> => {
  const fetchResult = await safeFetch(url, cache === undefined ? {} : { cache });

  if (!fetchResult.ok) {
    return {
      findings: [
        createFinding({
          confidence: "medium",
          evidence: {
            url: url.toString(),
            slug,
            reason: "non_gift_page",
            fetchError: fetchResult.error,
          },
          rule: getCoreRule("TELEGRAM_GIFT_LINK_NOT_VERIFIED"),
        }),
      ],
      actions: [],
    };
  }

  // If the redirect chain dropped us off the `/nft/<slug>` path entirely
  // (Telegram's 302-to-homepage for unknown slugs), we don't even need
  // to parse — the redirect itself is the verdict.
  const finalPath = fetchResult.value.finalUrl.pathname.toLowerCase();
  if (!finalPath.startsWith(`/nft/${slug.toLowerCase()}`)) {
    return {
      findings: [
        createFinding({
          confidence: "high",
          evidence: {
            url: url.toString(),
            finalUrl: fetchResult.value.finalUrl.toString(),
            slug,
            reason: "redirected_off_path",
          },
          rule: getCoreRule("TELEGRAM_GIFT_LINK_NOT_VERIFIED"),
        }),
      ],
      actions: [],
    };
  }

  const resolution = parseGiftPage(fetchResult.value.body, slug);

  if (resolution.status === "not_verified") {
    return {
      findings: [verifiedFailedFinding(url, slug, resolution.reason)],
      actions: [],
    };
  }

  return {
    findings: [],
    actions: [resolvedAction(resolution)],
  };
};

const verifiedFailedFinding = (
  url: URL,
  slug: string,
  reason: GiftLinkNotVerifiedReason,
): RiskFinding =>
  createFinding({
    // `slug_marker_mismatch` is the strongest signal — the page claims a
    // DIFFERENT slug than the one we asked for, which is consistent with
    // a fabricated link in a phishing message. Lower confidence for the
    // missing/non-gift cases (could be a transient anomaly).
    confidence: reason === "slug_marker_mismatch" ? "high" : "medium",
    evidence: { url: url.toString(), slug, reason },
    rule: getCoreRule("TELEGRAM_GIFT_LINK_NOT_VERIFIED"),
  });

const resolvedAction = (
  resolution: Extract<GiftLinkResolution, { status: "verified" }>,
): ActionPreview => {
  const { metadata } = resolution;
  const parts: string[] = [];
  if (metadata.model !== null) parts.push(`Model: ${metadata.model}`);
  if (metadata.backdrop !== null) parts.push(`Backdrop: ${metadata.backdrop}`);
  if (metadata.symbol !== null) parts.push(`Symbol: ${metadata.symbol}`);
  const description =
    parts.length > 0 ? parts.join(", ") : `Collectible #${String(metadata.collectibleNumber)}`;

  return {
    kind: "send_nft",
    title: `Telegram gift: ${metadata.title}`,
    description,
    assetDeltas: [],
  };
};
