import { createFinding, getCoreRule } from "@tonshield/risk-engine";
import type { RiskFinding } from "@tonshield/shared";
import {
  fetchChatGifts,
  type ChatGiftsResult,
  type NormalisedOwnedGift,
  type TelegramIntelClient,
} from "@tonshield/telegram-intel";
import type { GiftCatalogEntry, GiftCatalogStore } from "@tonshield/storage";

/**
 * Cross-references a chat's owned-gift inventory against the cached gift
 * catalog. Fires `TELEGRAM_GIFT_FROM_UNKNOWN_PUBLISHER` when at least one
 * owned unique gift fails the catalog check.
 *
 * Failure conditions (per gift):
 *   - `catalog_miss`: the `gift_id` is absent from the catalog store AND
 *     the gift is NOT tagged `is_from_blockchain`. Blockchain-issued
 *     gifts legitimately bypass the catalog; catalog absence for a
 *     normal gift is the suspicious shape.
 *   - `publisher_mismatch`: the gift's `publisher_chat_id` (set by
 *     Telegram on the inline `UniqueGift`) disagrees with the catalog
 *     entry's `publisher_chat_id`. Telegram itself populates both fields
 *     so a real-world divergence is extremely rare, but the check
 *     catches data-shape drift / fabricated catalog entries.
 *
 * Silent degradation:
 *   - If the bot has no access to the chat (not a member, or chat is
 *     private), `getChatGifts` returns `not_resolvable` and we emit no
 *     finding. The almost-universal case for arbitrary scans.
 *   - If the chat has zero owned gifts, no finding either.
 *   - Bot API failures (rate-limit, provider-down) also degrade silently;
 *     `scanTelegramEntity`'s existing degradation rules will surface the
 *     Bot API health issue from the upstream `getChat` call when relevant.
 *
 * The rule fires at most once per scan with up to 5 example gifts in
 * evidence.
 */
export interface GiftPublisherScanResult {
  readonly findings: readonly RiskFinding[];
}

interface FlaggedGift {
  readonly giftId: string;
  readonly slug: string | null;
  readonly reason: "catalog_miss" | "publisher_mismatch";
  readonly ownedPublisherChatId: bigint | null;
  readonly catalogPublisherChatId: bigint | null;
}

const EMPTY_RESULT: GiftPublisherScanResult = { findings: [] };
const MAX_EVIDENCE_GIFTS = 5;

export const scanChatGiftsForUnknownPublisher = async (
  client: TelegramIntelClient,
  catalogStore: GiftCatalogStore,
  chatId: bigint,
  options: { readonly cap?: number } = {},
): Promise<GiftPublisherScanResult> => {
  // A catalog miss is only meaningful after the catalog has been populated
  // at least once. Fresh deployments, local memory storage, or a worker that
  // has not run yet should not turn every owned gift into a false positive.
  const catalogBaseline = await catalogStore.oldestRefreshedAt();
  if (catalogBaseline === null) {
    return EMPTY_RESULT;
  }

  const fetched: ChatGiftsResult = await fetchChatGifts(client, chatId, options);

  if (fetched.status !== "ok") {
    return EMPTY_RESULT;
  }

  const uniqueGifts = fetched.gifts.filter(isUniqueGift);
  if (uniqueGifts.length === 0) {
    return EMPTY_RESULT;
  }

  const flagged: FlaggedGift[] = [];
  for (const owned of uniqueGifts) {
    const catalog = await catalogStore.findByGiftId(owned.giftId);
    const verdict = classifyOwnedGift(owned, catalog);
    if (verdict !== null) {
      flagged.push(verdict);
    }
  }

  if (flagged.length === 0) {
    return EMPTY_RESULT;
  }

  return {
    findings: [
      createFinding({
        confidence: confidenceFromFlagged(flagged),
        evidence: {
          chatId: chatId.toString(),
          inspectedCount: uniqueGifts.length,
          flaggedCount: flagged.length,
          truncated: fetched.truncated,
          gifts: flagged.slice(0, MAX_EVIDENCE_GIFTS).map((g) => ({
            giftId: g.giftId,
            ...(g.slug === null ? {} : { slug: g.slug }),
            reason: g.reason,
            ...(g.ownedPublisherChatId === null
              ? {}
              : { ownedPublisherChatId: g.ownedPublisherChatId.toString() }),
            ...(g.catalogPublisherChatId === null
              ? {}
              : { catalogPublisherChatId: g.catalogPublisherChatId.toString() }),
          })),
        },
        rule: getCoreRule("TELEGRAM_GIFT_FROM_UNKNOWN_PUBLISHER"),
      }),
    ],
  };
};

const isUniqueGift = (
  gift: NormalisedOwnedGift,
): gift is NormalisedOwnedGift & { readonly type: "unique" } => gift.type === "unique";

/**
 * Per-gift verdict. Returns the flagged shape or `null` if the gift
 * passes the catalog check.
 */
const classifyOwnedGift = (
  owned: NormalisedOwnedGift,
  catalog: GiftCatalogEntry | null,
): FlaggedGift | null => {
  if (catalog === null) {
    // Catalog miss is benign IFF the gift is blockchain-issued.
    if (owned.isFromBlockchain) return null;
    return {
      giftId: owned.giftId,
      slug: owned.uniqueSlug,
      reason: "catalog_miss",
      ownedPublisherChatId: owned.publisherChatId,
      catalogPublisherChatId: null,
    };
  }

  // Catalog hit — compare publisher_chat_id when both sides populate it.
  // If either side is null we cannot conclude mismatch; treat as a pass.
  if (
    owned.publisherChatId !== null &&
    catalog.publisherChatId !== null &&
    owned.publisherChatId !== catalog.publisherChatId
  ) {
    return {
      giftId: owned.giftId,
      slug: owned.uniqueSlug,
      reason: "publisher_mismatch",
      ownedPublisherChatId: owned.publisherChatId,
      catalogPublisherChatId: catalog.publisherChatId,
    };
  }

  return null;
};

/**
 * A `publisher_mismatch` is the stronger signal (Telegram itself
 * populates both sides; divergence is high-confidence weirdness).
 * `catalog_miss` is medium since cache staleness can produce
 * false positives until the refresh loop catches up.
 */
const confidenceFromFlagged = (flagged: readonly FlaggedGift[]): "low" | "medium" | "high" => {
  if (flagged.some((g) => g.reason === "publisher_mismatch")) return "high";
  return "medium";
};
