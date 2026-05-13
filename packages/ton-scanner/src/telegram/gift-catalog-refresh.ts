import {
  fetchAvailableGifts,
  type AvailableGiftsResult,
  type BotApiFailure,
  type NormalisedCatalogGift,
  type TelegramIntelClient,
} from "@tonshield/telegram-intel";
import type { GiftCatalogEntryInput, GiftCatalogStore } from "@tonshield/storage";

/**
 * Orchestrates a single `getAvailableGifts` refresh: pulls the public
 * catalog via `@tonshield/telegram-intel`'s `fetchAvailableGifts` and
 * upserts every entry into the `GiftCatalogStore`. Pure orchestration —
 * the Bot API call and the storage write are both already covered by
 * their own unit tests, so this module focuses on the wiring.
 *
 * Intended caller: the periodic refresh loop in `apps/worker`. The
 * orchestration is also reusable from one-shot CLI invocations (e.g. a
 * `bootstrap` script after a fresh DB).
 *
 * Failure posture: on a failed Bot API call we return the failure
 * verbatim — caller decides whether to log + retry. We do NOT throw,
 * because the worker loop must keep running across transient outages.
 */
export type GiftCatalogRefreshResult =
  | {
      readonly status: "ok";
      readonly refreshedCount: number;
      readonly refreshedAt: Date;
    }
  | {
      readonly status: "disabled";
    }
  | {
      readonly status: "failed";
      readonly failure: BotApiFailure;
      readonly attemptedAt: Date;
    };

export const refreshGiftCatalog = async (
  client: TelegramIntelClient,
  store: GiftCatalogStore,
  now: Date = new Date(),
): Promise<GiftCatalogRefreshResult> => {
  const fetched: AvailableGiftsResult = await fetchAvailableGifts(client);

  if (fetched.status === "disabled") {
    return { status: "disabled" };
  }
  if (fetched.status === "failed") {
    return { status: "failed", failure: fetched.failure, attemptedAt: now };
  }

  const inputs: readonly GiftCatalogEntryInput[] = fetched.gifts.map((gift) =>
    toEntryInput(gift, now),
  );
  await store.upsertMany(inputs);

  return { status: "ok", refreshedCount: inputs.length, refreshedAt: now };
};

const toEntryInput = (gift: NormalisedCatalogGift, observedAt: Date): GiftCatalogEntryInput => ({
  giftId: gift.giftId,
  publisherChatId: gift.publisherChatId,
  publisherChatUsername: gift.publisherChatUsername,
  publisherChatTitle: gift.publisherChatTitle,
  publisherChatType: gift.publisherChatType,
  starCount: gift.starCount,
  upgradeStarCount: gift.upgradeStarCount,
  totalCount: gift.totalCount,
  remainingCount: gift.remainingCount,
  stickerFileUniqueId: gift.stickerFileUniqueId,
  observedAt,
  raw: gift.raw,
});
