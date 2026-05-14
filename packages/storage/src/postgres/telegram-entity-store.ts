import { desc, eq, sql } from "drizzle-orm";
import type {
  RecordSnapshotResult,
  TelegramEntity,
  TelegramEntityKind,
  TelegramEntitySnapshot,
  TelegramEntitySnapshotInput,
  TelegramEntityStore,
  UsernameBinding,
} from "../interfaces/telegram-entity-store.ts";
import type { StorageDb } from "./client.ts";
import { telegramEntities, telegramEntitySnapshots } from "./schema.ts";

interface DbEntityRow {
  readonly id: bigint;
  readonly entityKind: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

interface DbSnapshotRow {
  readonly id: bigint;
  readonly entityId: bigint;
  readonly entityKind: string;
  readonly observedAt: Date;
  readonly username: string | null;
  readonly activeUsernames: string[] | null;
  readonly displayName: string | null;
  readonly bio: string | null;
  readonly photoFileUniqueId: string | null;
  readonly isPremium: boolean | null;
  readonly memberCount: number | null;
  readonly isBot: boolean | null;
  readonly source: string;
  readonly raw: unknown;
}

const toEntity = (row: DbEntityRow): TelegramEntity => ({
  id: row.id,
  kind: row.entityKind as TelegramEntityKind,
  firstSeenAt: row.firstSeenAt,
  lastSeenAt: row.lastSeenAt,
});

const toSnapshot = (row: DbSnapshotRow): TelegramEntitySnapshot => ({
  id: row.id,
  entityId: row.entityId,
  entityKind: row.entityKind as TelegramEntityKind,
  observedAt: row.observedAt,
  username: row.username,
  activeUsernames: row.activeUsernames,
  displayName: row.displayName,
  bio: row.bio,
  photoFileUniqueId: row.photoFileUniqueId,
  isPremium: row.isPremium,
  memberCount: row.memberCount,
  isBot: row.isBot,
  source: row.source as TelegramEntitySnapshotInput["source"],
  raw: row.raw === null ? null : (row.raw as Readonly<Record<string, unknown>>),
});

/**
 * Postgres-backed `TelegramEntityStore`. Transactionally upserts the
 * `telegram_entities` row and appends to `telegram_entity_snapshots`.
 * Cooldown suppression is implemented in the same transaction so a
 * concurrent scan can't double-insert.
 */
export const createPostgresTelegramEntityStore = (db: StorageDb): TelegramEntityStore => ({
  async recordSnapshot(input, options = {}) {
    const cooldownMs = options.cooldownMs ?? 0;

    return await db.transaction(async (tx) => {
      // Serialize snapshot writes per Telegram entity. Without this, two
      // concurrent identical observations can both read the same previous row
      // and both insert, bypassing the content-aware cooldown.
      await tx.execute(sql`select pg_advisory_xact_lock(${input.entityId.toString()}::bigint)`);

      const previousRows = (await tx
        .select()
        .from(telegramEntitySnapshots)
        .where(eq(telegramEntitySnapshots.entityId, input.entityId))
        .orderBy(desc(telegramEntitySnapshots.observedAt))
        .limit(2)) as readonly DbSnapshotRow[];

      const previousRow = previousRows[0];
      const beforePreviousRow = previousRows[1];
      const previous = previousRow === undefined ? null : toSnapshot(previousRow);
      const beforePrevious = beforePreviousRow === undefined ? null : toSnapshot(beforePreviousRow);

      if (
        previous !== null &&
        cooldownMs > 0 &&
        input.observedAt.getTime() - previous.observedAt.getTime() < cooldownMs &&
        observableAttributesEqual(previous, input)
      ) {
        return {
          snapshot: previous,
          previous: beforePrevious,
          inserted: false,
        } satisfies RecordSnapshotResult;
      }

      // Upsert the entity row. `first_seen_at` only set on insert; kind
      // is refined-not-degraded (don't overwrite a real kind with
      // "unknown").
      await tx
        .insert(telegramEntities)
        .values({
          id: input.entityId,
          entityKind: input.entityKind,
          firstSeenAt: input.observedAt,
          lastSeenAt: input.observedAt,
        })
        .onConflictDoUpdate({
          target: telegramEntities.id,
          set: {
            entityKind:
              input.entityKind === "unknown"
                ? sql`${telegramEntities.entityKind}`
                : input.entityKind,
            lastSeenAt: sql`greatest(${telegramEntities.lastSeenAt}, ${input.observedAt})`,
          },
        });

      const [inserted] = (await tx
        .insert(telegramEntitySnapshots)
        .values({
          entityId: input.entityId,
          entityKind: input.entityKind,
          observedAt: input.observedAt,
          username: input.username,
          activeUsernames: input.activeUsernames === null ? null : [...input.activeUsernames],
          displayName: input.displayName,
          bio: input.bio,
          photoFileUniqueId: input.photoFileUniqueId,
          isPremium: input.isPremium,
          memberCount: input.memberCount,
          isBot: input.isBot,
          source: input.source,
          raw: input.raw,
        })
        .returning()) as readonly DbSnapshotRow[];

      if (inserted === undefined) {
        throw new Error("telegram_entity_snapshots insert returned no row");
      }

      return {
        snapshot: toSnapshot(inserted),
        previous,
        inserted: true,
      } satisfies RecordSnapshotResult;
    });
  },

  async latestSnapshot(entityId) {
    const rows = (await db
      .select()
      .from(telegramEntitySnapshots)
      .where(eq(telegramEntitySnapshots.entityId, entityId))
      .orderBy(desc(telegramEntitySnapshots.observedAt))
      .limit(1)) as readonly DbSnapshotRow[];

    const first = rows[0];
    return first === undefined ? null : toSnapshot(first);
  },

  async recentSnapshots(entityId, limit) {
    const rows = (await db
      .select()
      .from(telegramEntitySnapshots)
      .where(eq(telegramEntitySnapshots.entityId, entityId))
      .orderBy(desc(telegramEntitySnapshots.observedAt))
      .limit(Math.max(0, limit))) as readonly DbSnapshotRow[];

    return rows.map(toSnapshot);
  },

  async findEntityByUsername(username) {
    const lowered = username.toLowerCase();
    const candidateRows = (await db
      .select()
      .from(telegramEntitySnapshots)
      .where(eq(telegramEntitySnapshots.username, lowered))
      .orderBy(desc(telegramEntitySnapshots.observedAt))
      .limit(50)) as readonly DbSnapshotRow[];

    // The username index can return historical bindings. The interface asks
    // for the entity currently bound to a username, so verify each candidate's
    // latest snapshot still carries the handle before returning it.
    for (const candidate of candidateRows) {
      const latestRows = (await db
        .select()
        .from(telegramEntitySnapshots)
        .where(eq(telegramEntitySnapshots.entityId, candidate.entityId))
        .orderBy(desc(telegramEntitySnapshots.observedAt))
        .limit(1)) as readonly DbSnapshotRow[];
      const latestRow = latestRows[0];
      const latest = latestRow === undefined ? null : toSnapshot(latestRow);

      if (latest?.username?.toLowerCase() !== lowered) {
        continue;
      }

      const entityRows = (await db
        .select()
        .from(telegramEntities)
        .where(eq(telegramEntities.id, candidate.entityId))
        .limit(1)) as readonly DbEntityRow[];

      const entity = entityRows[0];
      if (entity !== undefined) {
        return toEntity(entity);
      }
    }

    return null;
  },

  async usernameHistory(entityId) {
    const rows = (await db
      .select()
      .from(telegramEntitySnapshots)
      .where(eq(telegramEntitySnapshots.entityId, entityId))
      .orderBy(telegramEntitySnapshots.observedAt)) as readonly DbSnapshotRow[];

    const bindings: UsernameBinding[] = [];
    let currentUsername: string | null = null;
    let currentFrom: Date | null = null;

    for (const row of rows) {
      if (row.username === currentUsername) continue;

      if (currentUsername !== null && currentFrom !== null) {
        bindings.push({
          username: currentUsername,
          entityId,
          boundFrom: currentFrom,
          boundTo: row.observedAt,
          isCollectible: false,
        });
      }

      currentUsername = row.username;
      currentFrom = row.observedAt;
    }

    if (currentUsername !== null && currentFrom !== null) {
      bindings.push({
        username: currentUsername,
        entityId,
        boundFrom: currentFrom,
        boundTo: null,
        isCollectible: false,
      });
    }

    return bindings.reverse();
  },

  async pruneSnapshots({ cutoff, maxRows }) {
    if (maxRows <= 0) {
      return { deletedCount: 0 };
    }

    // CTE picks the oldest `maxRows` eligible rows up front. The DELETE
    // ... WHERE id IN (subselect) then removes exactly that set. Without
    // the CTE we'd risk a giant unbounded delete on a misconfigured
    // retention period; the cap is the load-bearing safety.
    //
    // `RETURNING 1` lets `rowCount` carry the actual deleted count even
    // on impls that don't always populate it from DELETE-without-RETURNING.
    const result = await db.execute(sql`
      WITH eligible AS (
        SELECT id
        FROM ${telegramEntitySnapshots}
        WHERE observed_at < ${cutoff.toISOString()}
        ORDER BY observed_at ASC
        LIMIT ${maxRows}
      )
      DELETE FROM ${telegramEntitySnapshots}
      WHERE id IN (SELECT id FROM eligible)
      RETURNING 1
    `);

    return { deletedCount: result.rowCount ?? 0 };
  },
});

const observableAttributesEqual = (
  existing: TelegramEntitySnapshot,
  next: TelegramEntitySnapshotInput,
): boolean =>
  existing.username === next.username &&
  arraysEqual(existing.activeUsernames, next.activeUsernames) &&
  existing.displayName === next.displayName &&
  existing.bio === next.bio &&
  existing.photoFileUniqueId === next.photoFileUniqueId &&
  existing.isPremium === next.isPremium &&
  existing.memberCount === next.memberCount &&
  existing.isBot === next.isBot &&
  existing.entityKind === next.entityKind;

const arraysEqual = (a: readonly string[] | null, b: readonly string[] | null): boolean => {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
};
