import { asc, eq, sql } from "drizzle-orm";
import type {
  GiftCatalogEntry,
  GiftCatalogEntryInput,
  GiftCatalogStore,
} from "../interfaces/gift-catalog-store.ts";
import type { StorageDb } from "./client.ts";
import { telegramGiftCatalog } from "./schema.ts";

interface DbCatalogRow {
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
  readonly firstSeenAt: Date;
  readonly lastRefreshedAt: Date;
  readonly raw: unknown;
}

const toEntry = (row: DbCatalogRow): GiftCatalogEntry => ({
  giftId: row.giftId,
  publisherChatId: row.publisherChatId,
  publisherChatUsername: row.publisherChatUsername,
  publisherChatTitle: row.publisherChatTitle,
  publisherChatType: row.publisherChatType,
  starCount: row.starCount,
  upgradeStarCount: row.upgradeStarCount,
  totalCount: row.totalCount,
  remainingCount: row.remainingCount,
  stickerFileUniqueId: row.stickerFileUniqueId,
  firstSeenAt: row.firstSeenAt,
  lastRefreshedAt: row.lastRefreshedAt,
  raw: row.raw === null ? null : (row.raw as Readonly<Record<string, unknown>>),
});

const insertValues = (input: GiftCatalogEntryInput) => ({
  giftId: input.giftId,
  publisherChatId: input.publisherChatId,
  publisherChatUsername: input.publisherChatUsername,
  publisherChatTitle: input.publisherChatTitle,
  publisherChatType: input.publisherChatType,
  starCount: input.starCount,
  upgradeStarCount: input.upgradeStarCount,
  totalCount: input.totalCount,
  remainingCount: input.remainingCount,
  stickerFileUniqueId: input.stickerFileUniqueId,
  firstSeenAt: input.observedAt,
  lastRefreshedAt: input.observedAt,
  raw: input.raw,
});

/**
 * Postgres-backed `GiftCatalogStore`. Upserts overwrite mutable fields
 * and advance `last_refreshed_at`; `first_seen_at` is preserved via
 * `excluded` semantics (drizzle's `onConflictDoUpdate` only updates
 * listed columns).
 */
export const createPostgresGiftCatalogStore = (db: StorageDb): GiftCatalogStore => {
  const upsert = async (
    runner: StorageDb,
    input: GiftCatalogEntryInput,
  ): Promise<GiftCatalogEntry> => {
    const [row] = (await runner
      .insert(telegramGiftCatalog)
      .values(insertValues(input))
      .onConflictDoUpdate({
        target: telegramGiftCatalog.giftId,
        set: {
          publisherChatId: input.publisherChatId,
          publisherChatUsername: input.publisherChatUsername,
          publisherChatTitle: input.publisherChatTitle,
          publisherChatType: input.publisherChatType,
          starCount: input.starCount,
          upgradeStarCount: input.upgradeStarCount,
          totalCount: input.totalCount,
          remainingCount: input.remainingCount,
          stickerFileUniqueId: input.stickerFileUniqueId,
          lastRefreshedAt: sql`greatest(${telegramGiftCatalog.lastRefreshedAt}, ${input.observedAt})`,
          raw: input.raw,
        },
      })
      .returning()) as readonly DbCatalogRow[];

    if (row === undefined) {
      throw new Error("telegram_gift_catalog upsert returned no row");
    }
    return toEntry(row);
  };

  return {
    upsertEntry(input) {
      return upsert(db, input);
    },

    async upsertMany(inputs) {
      if (inputs.length === 0) return [];
      return await db.transaction(async (tx) => {
        const results: GiftCatalogEntry[] = [];
        for (const input of inputs) {
          results.push(await upsert(tx, input));
        }
        return results;
      });
    },

    async findByGiftId(giftId) {
      const rows = (await db
        .select()
        .from(telegramGiftCatalog)
        .where(eq(telegramGiftCatalog.giftId, giftId))
        .limit(1)) as readonly DbCatalogRow[];
      const first = rows[0];
      return first === undefined ? null : toEntry(first);
    },

    async findByPublisherChatId(chatId) {
      const rows = (await db
        .select()
        .from(telegramGiftCatalog)
        .where(eq(telegramGiftCatalog.publisherChatId, chatId))) as readonly DbCatalogRow[];
      return rows.map(toEntry);
    },

    async oldestRefreshedAt() {
      const rows = (await db
        .select({ lastRefreshedAt: telegramGiftCatalog.lastRefreshedAt })
        .from(telegramGiftCatalog)
        .orderBy(asc(telegramGiftCatalog.lastRefreshedAt))
        .limit(1)) as readonly { lastRefreshedAt: Date }[];
      const first = rows[0];
      return first === undefined ? null : first.lastRefreshedAt;
    },
  };
};
