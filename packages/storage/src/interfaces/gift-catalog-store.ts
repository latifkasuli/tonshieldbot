/**
 * Persistent cache of Telegram's gift catalog (the result of the Bot API
 * `getAvailableGifts` call). Keyed by the catalog `gift_id`.
 *
 * Why a cache: `getAvailableGifts` is rate-limited and returns the full
 * catalog every call. Real-time scans don't want to re-fetch the whole
 * list per request; the cache absorbs that and lets PR-8 do the (`gift_id`
 * → `publisher_chat_id`) lookup the owned-gift inventory path needs to
 * answer "did a recognised publisher actually issue this gift?".
 *
 * Schema rationale:
 *   - One row per `gift_id`. The catalog changes infrequently (new gift
 *     drops every few weeks); upsert-on-refresh is enough — no append-only
 *     history like `telegram_entity_snapshots`. We retain `first_seen_at`
 *     so we can answer "was this gift in the catalog when we first saw
 *     it?" and `last_refreshed_at` to drive refresh cadence.
 *   - `publisher_chat_*` columns are denormalised from the Chat object the
 *     Bot API includes inline. Storing them avoids a join against
 *     `telegram_entities` on every gift lookup. They are nullable because
 *     Telegram only added `publisher_chat` to `Gift` in a recent Bot API
 *     update and older / Fragment-issued gifts may not carry it.
 *   - `raw` jsonb captures the full Bot API payload for forward-compat —
 *     same pattern as `telegram_entity_snapshots.raw`.
 *
 * **Not** in scope for PR-7: the actual refresh job (PR-8) or the
 * "unknown publisher" rule that consumes this store (PR-8). This PR adds
 * the table and the read/write surface only.
 */

export interface GiftCatalogEntryInput {
  /** Catalog gift_id from Bot API `Gift.id`. Opaque string, treated as PK. */
  readonly giftId: string;
  /**
   * Telegram dialog ID of the publishing chat, when the Bot API populates
   * `Gift.publisher_chat`. Null for catalog entries Telegram didn't tag
   * with a publisher (older Fragment-issued gifts, or future schema drift).
   */
  readonly publisherChatId: bigint | null;
  /** Cached `publisher_chat.username` (without `@`), if present. */
  readonly publisherChatUsername: string | null;
  /** Cached `publisher_chat.title`, if present. */
  readonly publisherChatTitle: string | null;
  /** Cached `publisher_chat.type` (e.g. "channel"). */
  readonly publisherChatType: string | null;
  /** `Gift.star_count` — required by Bot API. */
  readonly starCount: number;
  /** `Gift.upgrade_star_count` — optional, only on upgradeable gifts. */
  readonly upgradeStarCount: number | null;
  /** `Gift.total_count` — optional, only on limited gifts. */
  readonly totalCount: number | null;
  /** `Gift.remaining_count` — optional, only on limited gifts. */
  readonly remainingCount: number | null;
  /** `Gift.sticker.file_unique_id` — stable visual identifier. */
  readonly stickerFileUniqueId: string | null;
  /** When the caller observed this catalog entry (typically `Date.now()`). */
  readonly observedAt: Date;
  /** Full Bot API payload for forward-compat. May be null in tests. */
  readonly raw: Readonly<Record<string, unknown>> | null;
}

export interface GiftCatalogEntry {
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
  readonly raw: Readonly<Record<string, unknown>> | null;
  /** First time this `gift_id` was observed. Set on insert, never updated. */
  readonly firstSeenAt: Date;
  /** Most recent `observedAt` from any refresh. Advanced on upsert. */
  readonly lastRefreshedAt: Date;
}

export interface GiftCatalogStore {
  /**
   * Insert-or-update a single catalog entry. `firstSeenAt` is set on
   * insert and preserved on update; `lastRefreshedAt` and every other
   * field is overwritten from the input.
   */
  upsertEntry(input: GiftCatalogEntryInput): Promise<GiftCatalogEntry>;

  /**
   * Convenience for the refresh job (PR-8) that hands the full catalog
   * back. Equivalent to N calls to `upsertEntry`, but the Postgres impl
   * runs them in a single transaction.
   */
  upsertMany(inputs: readonly GiftCatalogEntryInput[]): Promise<readonly GiftCatalogEntry[]>;

  /** Returns the cached entry for `giftId`, or `null` if absent. */
  findByGiftId(giftId: string): Promise<GiftCatalogEntry | null>;

  /**
   * Returns every catalog entry whose `publisherChatId` matches.
   * PR-8 uses this to answer the inverse direction:
   * "which catalog gifts does this chat publish?".
   */
  findByPublisherChatId(chatId: bigint): Promise<readonly GiftCatalogEntry[]>;

  /**
   * Oldest `lastRefreshedAt` across all entries — the staleness signal
   * that drives the refresh cadence. `null` when the store is empty.
   */
  oldestRefreshedAt(): Promise<Date | null>;
}
