import { sql } from "drizzle-orm";
import { char, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
