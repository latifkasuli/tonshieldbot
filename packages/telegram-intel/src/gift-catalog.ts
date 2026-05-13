import type { Gift, OwnedGift } from "grammy/types";
import type { TelegramIntelClient } from "./client.ts";
import { classifyBotApiFailure, type BotApiFailure } from "./failure.ts";

/**
 * Bot API helpers for Telegram's gift surfaces — `getAvailableGifts`
 * (the public catalog) and `getChatGifts` (a chat's owned-gift inventory).
 *
 * The helpers normalise grammY's response shapes into discriminated
 * results consistent with `entity-resolver.ts` so callers don't repeat
 * try/catch boilerplate. They do NOT write to the catalog store — that
 * orchestration lives in `@tonshield/ton-scanner/telegram/gift-catalog-refresh.ts`.
 *
 * Notes from the Bot API spec:
 *   - `getAvailableGifts()` is unauthenticated relative to chat context
 *     (any bot token can call it) and returns the full catalog every time.
 *     There is no pagination — Telegram returns ~50–100 gifts in one go.
 *   - `getChatGifts({chat_id})` requires the bot to be a member of the
 *     chat. For non-member chats Telegram returns 400 / `not_resolvable`.
 *     Pagination via `offset` / `next_offset` (empty string = first page).
 */

export type AvailableGiftsResult =
  | {
      readonly status: "ok";
      readonly gifts: readonly NormalisedCatalogGift[];
    }
  | { readonly status: "disabled" }
  | { readonly status: "failed"; readonly failure: BotApiFailure };

export type ChatGiftsResult =
  | {
      readonly status: "ok";
      /** Owned gifts, in the order Telegram returned them. */
      readonly gifts: readonly NormalisedOwnedGift[];
      /** True iff pagination stopped because we reached the configured cap. */
      readonly truncated: boolean;
    }
  | { readonly status: "disabled" }
  | {
      readonly status: "not_resolvable";
      readonly reason: "chat_not_accessible" | "no_gifts";
      readonly description: string | null;
    }
  | { readonly status: "failed"; readonly failure: BotApiFailure };

/**
 * One catalog entry, mapped from `Gift` to the shape the store needs. The
 * field set mirrors `GiftCatalogEntryInput` from `@tonshield/storage`
 * (intentionally — we don't import the storage type here to avoid a
 * dependency edge from telegram-intel to storage).
 */
export interface NormalisedCatalogGift {
  readonly giftId: string;
  readonly publisherChatId: bigint | null;
  readonly publisherChatUsername: string | null;
  readonly publisherChatTitle: string | null;
  readonly publisherChatType: string | null;
  readonly starCount: number;
  readonly upgradeStarCount: number | null;
  readonly totalCount: number | null;
  readonly remainingCount: number | null;
  readonly stickerFileUniqueId: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * One owned-gift entry. Captures the fields the unknown-publisher rule
 * needs: the `gift_id` (or `UniqueGift.gift_id`) to look up in the
 * catalog, the publisher_chat the Bot API tagged inline, and the
 * unique-slug (`UniqueGift.name`, e.g. `PlushPepe-10`) for evidence
 * rendering.
 */
export interface NormalisedOwnedGift {
  readonly type: "regular" | "unique";
  /** For regular gifts: `Gift.id`. For unique gifts: `UniqueGift.gift_id`. */
  readonly giftId: string;
  /**
   * Only set on unique gifts — the `t.me/nft/<slug>` slug the gift renders as.
   */
  readonly uniqueSlug: string | null;
  /** `UniqueGift.publisher_chat.id` or `Gift.publisher_chat.id` if Telegram populates it. */
  readonly publisherChatId: bigint | null;
  readonly publisherChatUsername: string | null;
  /** `UniqueGift.is_from_blockchain` — gift was crafted on TON, not catalog-issued. */
  readonly isFromBlockchain: boolean;
  /** Raw Bot API payload for forensic replay. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Default cap on how many owned gifts to page through per chat. */
export const DEFAULT_CHAT_GIFTS_CAP = 200;
/** Bot API `getChatGifts` per-page limit. */
const CHAT_GIFTS_PAGE_SIZE = 100;

/**
 * Fetch the public gift catalog. The result is fully normalised — caller
 * can hand it straight to `GiftCatalogStore.upsertMany` (the field names
 * line up by design).
 */
export const fetchAvailableGifts = async (
  client: TelegramIntelClient,
): Promise<AvailableGiftsResult> => {
  if (!client.enabled) {
    return { status: "disabled" };
  }

  try {
    const response = await client.raw.getAvailableGifts();
    return { status: "ok", gifts: response.gifts.map(normaliseCatalogGift) };
  } catch (error) {
    return { status: "failed", failure: classifyBotApiFailure(error) };
  }
};

/**
 * Fetch a chat's owned-gift inventory. Pages through `getChatGifts` until
 * either Telegram returns an empty `next_offset` or we hit `cap` results.
 * Pagination stops early on the first failure of a subsequent page —
 * partial results are still returned with `truncated: true` so the rule
 * has something to work with.
 */
export const fetchChatGifts = async (
  client: TelegramIntelClient,
  chatId: bigint,
  options: { readonly cap?: number } = {},
): Promise<ChatGiftsResult> => {
  if (!client.enabled) {
    return { status: "disabled" };
  }
  const cap = options.cap ?? DEFAULT_CHAT_GIFTS_CAP;

  const collected: NormalisedOwnedGift[] = [];
  let offset = "";
  let truncated = false;

  for (;;) {
    let page: Awaited<ReturnType<TelegramIntelClient["raw"]["getChatGifts"]>>;
    try {
      // grammY's `Api.getChatGifts` types `chat_id` as `number` (the
      // `@grammyjs/types` raw method signature accepts `number | string`,
      // but the Api wrapper narrows it). Telegram IDs fit in 52
      // significant bits per <https://core.telegram.org/api/bots/ids>, so
      // `Number(bigint)` is loss-free for every legitimate chat ID.
      page = await client.raw.getChatGifts(Number(chatId), {
        offset,
        limit: CHAT_GIFTS_PAGE_SIZE,
      });
    } catch (error) {
      // If we already collected something, return partial rather than
      // throw away progress; otherwise surface the failure.
      const failure = classifyBotApiFailure(error);
      if (collected.length > 0) {
        return { status: "ok", gifts: collected, truncated: true };
      }
      if (failure.status === "not_resolvable") {
        return {
          status: "not_resolvable",
          reason: "chat_not_accessible",
          description: failure.description,
        };
      }
      return { status: "failed", failure };
    }

    for (const owned of page.gifts) {
      collected.push(normaliseOwnedGift(owned));
      if (collected.length >= cap) {
        truncated = true;
        break;
      }
    }

    if (truncated || page.next_offset === undefined || page.next_offset.length === 0) {
      break;
    }
    offset = page.next_offset;
  }

  if (collected.length === 0) {
    return { status: "not_resolvable", reason: "no_gifts", description: null };
  }

  return { status: "ok", gifts: collected, truncated };
};

// ── normalisation helpers ────────────────────────────────────────────────

const normaliseCatalogGift = (gift: Gift): NormalisedCatalogGift => {
  const publisher = gift.publisher_chat ?? null;
  return {
    giftId: gift.id,
    publisherChatId: publisher === null ? null : BigInt(publisher.id),
    publisherChatUsername: publisher === null ? null : (chatUsername(publisher) ?? null),
    publisherChatTitle: publisher === null ? null : (chatTitle(publisher) ?? null),
    publisherChatType: publisher === null ? null : publisher.type,
    starCount: gift.star_count,
    upgradeStarCount: gift.upgrade_star_count ?? null,
    totalCount: gift.total_count ?? null,
    remainingCount: gift.remaining_count ?? null,
    stickerFileUniqueId: gift.sticker.file_unique_id,
    raw: gift as unknown as Readonly<Record<string, unknown>>,
  };
};

const normaliseOwnedGift = (owned: OwnedGift): NormalisedOwnedGift => {
  if (owned.type === "unique") {
    const u = owned.gift;
    const publisher = u.publisher_chat ?? null;
    return {
      type: "unique",
      giftId: u.gift_id,
      uniqueSlug: u.name,
      publisherChatId: publisher === null ? null : BigInt(publisher.id),
      publisherChatUsername: publisher === null ? null : (chatUsername(publisher) ?? null),
      isFromBlockchain: u.is_from_blockchain === true,
      raw: owned as unknown as Readonly<Record<string, unknown>>,
    };
  }

  const g = owned.gift;
  const publisher = g.publisher_chat ?? null;
  return {
    type: "regular",
    giftId: g.id,
    uniqueSlug: null,
    publisherChatId: publisher === null ? null : BigInt(publisher.id),
    publisherChatUsername: publisher === null ? null : (chatUsername(publisher) ?? null),
    isFromBlockchain: false,
    raw: owned as unknown as Readonly<Record<string, unknown>>,
  };
};

// grammY's `Chat` is a discriminated union — `username` and `title` only
// exist on certain shapes. Pull them defensively without narrowing on
// every case. The `| undefined` is required under
// `exactOptionalPropertyTypes`.
const chatUsername = (chat: { username?: string | undefined }): string | null =>
  typeof chat.username === "string" && chat.username.length > 0 ? chat.username : null;

const chatTitle = (chat: { title?: string | undefined }): string | null =>
  typeof chat.title === "string" && chat.title.length > 0 ? chat.title : null;
