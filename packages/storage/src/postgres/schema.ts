import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle schema for the storage layer.
 *
 * Conventions:
 * - Primary keys are UUIDs (matching `randomUUID()` output domain-side).
 * - Hashes are `char(64)` because SHA-256 hex is fixed-length; the column
 *   type signals intent and prevents accidental varchar drift.
 * - `text[]` for `scopes` (small enum, app-validated) — easier to filter on
 *   than jsonb arrays and still flexible.
 * - `jsonb` for the dynamic `ScanInput` / findings / actions blobs. URLs
 *   serialize to strings; the Postgres impl re-hydrates them on read.
 */

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    keyHash: char("key_hash", { length: 64 }).notNull().unique(),
    name: text("name").notNull(),
    scopes: text("scopes").array().notNull(),
    rateLimitTier: text("rate_limit_tier").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("api_keys_tenant_id_idx").on(table.tenantId)],
);

export const reports = pgTable("reports", {
  id: uuid("id").primaryKey(),
  inputHash: char("input_hash", { length: 64 }).notNull().unique(),
  input: jsonb("input").notNull(),
  verdict: text("verdict").notNull(),
  riskScore: integer("risk_score").notNull(),
  confidence: text("confidence").notNull(),
  summary: text("summary").notNull(),
  findings: jsonb("findings").notNull(),
  actions: jsonb("actions").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

// ── M3 Telegram intelligence ────────────────────────────────────────────────
//
// Per docs/research/m3-design.md §4. Snapshots are append-only; the entity
// row tracks first/last-seen and the stable type.
//
// `entityId` is the Bot API signed dialog ID (range table at
// <https://core.telegram.org/api/bots/ids>). It fits in 52 significant
// bits, so JS `number` (53-bit safe) would work, but we use Postgres
// `bigint` for forward-compat and to keep the column semantically distinct
// from row-count integers elsewhere.

export const telegramEntities = pgTable("telegram_entities", {
  id: bigint("id", { mode: "bigint" }).primaryKey(),
  entityKind: text("entity_kind").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
});

export const telegramEntitySnapshots = pgTable(
  "telegram_entity_snapshots",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    entityId: bigint("entity_id", { mode: "bigint" })
      .notNull()
      .references(() => telegramEntities.id, { onDelete: "cascade" }),
    entityKind: text("entity_kind").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    username: text("username"),
    activeUsernames: text("active_usernames").array(),
    displayName: text("display_name"),
    bio: text("bio"),
    photoFileUniqueId: text("photo_file_unique_id"),
    isPremium: boolean("is_premium"),
    memberCount: integer("member_count"),
    isBot: boolean("is_bot"),
    source: text("source").notNull(),
    raw: jsonb("raw"),
  },
  (table) => [
    index("telegram_entity_snapshots_entity_observed_idx").on(table.entityId, table.observedAt),
    index("telegram_entity_snapshots_username_idx").on(table.username),
    index("telegram_entity_snapshots_photo_idx").on(table.photoFileUniqueId),
  ],
);

export const telegramMigrationEdges = pgTable(
  "telegram_migration_edges",
  {
    fromEntityId: bigint("from_entity_id", { mode: "bigint" }).notNull(),
    toEntityId: bigint("to_entity_id", { mode: "bigint" }).notNull(),
    kind: text("kind").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // Composite primary key — see migration SQL for the actual constraint.
    index("telegram_migration_edges_from_idx").on(table.fromEntityId),
    index("telegram_migration_edges_to_idx").on(table.toEntityId),
  ],
);

export const telegramUsernameBindings = pgTable(
  "telegram_username_bindings",
  {
    username: text("username").notNull(),
    entityId: bigint("entity_id", { mode: "bigint" }).notNull(),
    boundFrom: timestamp("bound_from", { withTimezone: true }).notNull(),
    boundTo: timestamp("bound_to", { withTimezone: true }),
    isCollectible: boolean("is_collectible").notNull().default(false),
  },
  (table) => [
    index("telegram_username_bindings_username_idx").on(table.username, table.boundFrom),
    index("telegram_username_bindings_entity_idx").on(table.entityId),
  ],
);

// ── M3 PR-7: gift catalog cache ────────────────────────────────────────────
//
// Cache of `getAvailableGifts` results. Keyed by Bot API `Gift.id` (opaque
// string). Publisher-chat columns are denormalised from the inline `Chat`
// object so PR-8's owned-gift inventory rule can answer "did a known
// publisher issue this gift?" without joining `telegram_entities`.

export const telegramGiftCatalog = pgTable(
  "telegram_gift_catalog",
  {
    giftId: text("gift_id").primaryKey(),
    publisherChatId: bigint("publisher_chat_id", { mode: "bigint" }),
    publisherChatUsername: text("publisher_chat_username"),
    publisherChatTitle: text("publisher_chat_title"),
    publisherChatType: text("publisher_chat_type"),
    starCount: integer("star_count").notNull(),
    upgradeStarCount: integer("upgrade_star_count"),
    totalCount: integer("total_count"),
    remainingCount: integer("remaining_count"),
    stickerFileUniqueId: text("sticker_file_unique_id"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }).notNull(),
    raw: jsonb("raw"),
  },
  (table) => [
    index("telegram_gift_catalog_publisher_chat_idx").on(table.publisherChatId),
    index("telegram_gift_catalog_last_refreshed_idx").on(table.lastRefreshedAt),
  ],
);
