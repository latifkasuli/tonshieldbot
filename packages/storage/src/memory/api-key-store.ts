import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ApiKeyMetadata,
  ApiKeyStore,
  CreateApiKeyInput,
  CreatedApiKey,
  ResolvedApiKey,
} from "../interfaces/api-key-store.ts";

const KEY_PREFIX = "tsk_"; // "ton-shield key" — easy to grep for in logs/errors
const KEY_BYTES = 32; // 256 bits of entropy in the raw key

const hashKey = (rawKey: string): string => createHash("sha256").update(rawKey).digest("hex");

const generateRawKey = (): string => `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString("base64url")}`;

export interface InMemoryApiKeyStoreOptions {
  readonly now?: () => Date;
  readonly idGenerator?: () => string;
  readonly keyGenerator?: () => string;
}

interface StoredApiKey {
  readonly id: string;
  readonly tenantId: string;
  readonly hash: string;
  readonly name: string;
  readonly scopes: readonly ApiKeyMetadata["scopes"][number][];
  readonly rateLimitTier: ApiKeyMetadata["rateLimitTier"];
  readonly createdAt: string;
  // Mutable fields are pulled out and tracked separately so the stored
  // record itself stays immutable; we replace it on update.
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

const toMetadata = (stored: StoredApiKey): ApiKeyMetadata => ({
  id: stored.id,
  tenantId: stored.tenantId,
  scopes: stored.scopes,
  rateLimitTier: stored.rateLimitTier,
  name: stored.name,
  createdAt: stored.createdAt,
  lastUsedAt: stored.lastUsedAt,
  revokedAt: stored.revokedAt,
});

const toResolved = (stored: StoredApiKey): ResolvedApiKey => ({
  id: stored.id,
  tenantId: stored.tenantId,
  scopes: stored.scopes,
  rateLimitTier: stored.rateLimitTier,
});

export const createInMemoryApiKeyStore = (
  options: InMemoryApiKeyStoreOptions = {},
): ApiKeyStore => {
  const now = options.now ?? (() => new Date());
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const keyGenerator = options.keyGenerator ?? generateRawKey;
  const byId = new Map<string, StoredApiKey>();
  const byHash = new Map<string, string>(); // hash -> id

  return {
    async create(input: CreateApiKeyInput) {
      const rawKey = keyGenerator();
      const hash = hashKey(rawKey);
      const stored: StoredApiKey = {
        id: idGenerator(),
        tenantId: input.tenantId,
        hash,
        name: input.name,
        scopes: input.scopes,
        rateLimitTier: input.rateLimitTier,
        createdAt: now().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      };

      byId.set(stored.id, stored);
      byHash.set(hash, stored.id);

      const result: CreatedApiKey = { rawKey, metadata: toMetadata(stored) };

      return Promise.resolve(result);
    },

    async verify(rawKey) {
      const hash = hashKey(rawKey);
      const id = byHash.get(hash);

      if (id === undefined) {
        return Promise.resolve(null);
      }

      const stored = byId.get(id);

      // Reject when missing or already revoked. Optional chaining collapses
      // both checks: `stored?.revokedAt` is undefined for missing keys and
      // a timestamp string for revoked ones; only an active key has it null.
      if (stored?.revokedAt !== null) {
        return Promise.resolve(null);
      }

      return Promise.resolve(toResolved(stored));
    },

    async findById(id) {
      const stored = byId.get(id);

      return Promise.resolve(stored === undefined ? null : toMetadata(stored));
    },

    async listByTenant(tenantId) {
      const results: ApiKeyMetadata[] = [];

      for (const stored of byId.values()) {
        if (stored.tenantId === tenantId) {
          results.push(toMetadata(stored));
        }
      }

      return Promise.resolve(results);
    },

    async revoke(id) {
      const stored = byId.get(id);

      if (stored === undefined) {
        throw new Error(`API key not found: ${id}`);
      }

      if (stored.revokedAt !== null) {
        return Promise.resolve();
      }

      byId.set(id, { ...stored, revokedAt: now().toISOString() });

      return Promise.resolve();
    },

    async touchLastUsed(id) {
      const stored = byId.get(id);

      if (stored === undefined) {
        return Promise.resolve();
      }

      byId.set(id, { ...stored, lastUsedAt: now().toISOString() });

      return Promise.resolve();
    },
  };
};
