import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type {
  ApiKeyMetadata,
  ApiKeyScope,
  ApiKeyStore,
  CreateApiKeyInput,
  CreatedApiKey,
  RateLimitTier,
  ResolvedApiKey,
} from "../interfaces/api-key-store.ts";
import type { StorageDb } from "./client.ts";
import { apiKeys } from "./schema.ts";

const KEY_PREFIX = "tsk_";
const KEY_BYTES = 32;

const hashKey = (rawKey: string): string => createHash("sha256").update(rawKey).digest("hex");

const generateRawKey = (): string => `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString("base64url")}`;

interface DbApiKey {
  readonly id: string;
  readonly tenantId: string;
  readonly keyHash: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly rateLimitTier: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

const toMetadata = (row: DbApiKey): ApiKeyMetadata => ({
  id: row.id,
  tenantId: row.tenantId,
  // Cast at the boundary: scope/tier values were validated by the app on
  // the way in. If someone hand-edits the DB they get a typed surprise,
  // which is the correct outcome.
  scopes: row.scopes as readonly ApiKeyScope[],
  rateLimitTier: row.rateLimitTier as RateLimitTier,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.toISOString(),
  revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
});

const toResolved = (row: DbApiKey): ResolvedApiKey => ({
  id: row.id,
  tenantId: row.tenantId,
  scopes: row.scopes as readonly ApiKeyScope[],
  rateLimitTier: row.rateLimitTier as RateLimitTier,
});

export interface PostgresApiKeyStoreOptions {
  readonly keyGenerator?: () => string;
}

export const createPostgresApiKeyStore = (
  db: StorageDb,
  options: PostgresApiKeyStoreOptions = {},
): ApiKeyStore => {
  const keyGenerator = options.keyGenerator ?? generateRawKey;

  return {
    async create(input: CreateApiKeyInput): Promise<CreatedApiKey> {
      const rawKey = keyGenerator();
      const keyHash = hashKey(rawKey);
      const [row] = await db
        .insert(apiKeys)
        .values({
          tenantId: input.tenantId,
          keyHash,
          name: input.name,
          scopes: [...input.scopes],
          rateLimitTier: input.rateLimitTier,
        })
        .returning();

      if (row === undefined) {
        throw new Error("INSERT INTO api_keys returned no row");
      }

      return { rawKey, metadata: toMetadata(row) };
    },

    async verify(rawKey) {
      const keyHash = hashKey(rawKey);
      const rows = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
      const row = rows[0];

      // Optional chain collapses missing-row + revoked into one branch:
      // `row?.revokedAt` is undefined if the row is missing and a Date if
      // revoked; only an active key has it null.
      if (row?.revokedAt !== null) {
        return null;
      }

      return toResolved(row);
    },

    async findById(id) {
      const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
      const row = rows[0];

      return row === undefined ? null : toMetadata(row);
    },

    async listByTenant(tenantId) {
      const rows = await db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantId));

      return rows.map(toMetadata);
    },

    async revoke(id) {
      // Two-step: distinguish "not found" from "already revoked" without
      // racing on the same row. UPDATE ... WHERE id = ? AND revoked_at IS
      // NULL is idempotent; we look up afterward to surface the not-found
      // case as a thrown error, per the interface contract.
      const updated = await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });

      if (updated.length > 0) {
        return;
      }

      const existing = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.id, id))
        .limit(1);

      if (existing.length === 0) {
        throw new Error(`API key not found: ${id}`);
      }
      // Already revoked — idempotent no-op.
    },

    async touchLastUsed(id) {
      await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
    },
  };
};
