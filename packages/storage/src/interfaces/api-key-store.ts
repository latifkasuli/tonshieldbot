export const apiKeyScopes = ["scan:read", "scan:write"] as const;
export type ApiKeyScope = (typeof apiKeyScopes)[number];

export const rateLimitTiers = ["free", "partner", "internal"] as const;
export type RateLimitTier = (typeof rateLimitTiers)[number];

/**
 * The minimal slice of an API key that the auth middleware needs for every
 * authenticated request: identity + scopes + rate-limit tier. No timestamps,
 * no human label. Returned by `verify` to keep hot-path payloads small.
 */
export interface ResolvedApiKey {
  readonly id: string;
  readonly tenantId: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly rateLimitTier: RateLimitTier;
}

/**
 * Full metadata for admin/list flows. Includes everything `ResolvedApiKey`
 * has plus housekeeping fields. Never includes the raw key — only its hash
 * is ever stored.
 */
export interface ApiKeyMetadata extends ResolvedApiKey {
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export interface CreateApiKeyInput {
  readonly tenantId: string;
  readonly name: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly rateLimitTier: RateLimitTier;
}

export interface CreatedApiKey {
  /** The raw key. Shown to the operator once at creation; never retrievable again. */
  readonly rawKey: string;
  readonly metadata: ApiKeyMetadata;
}

/**
 * API key store.
 *
 * Storage rule: only the SHA-256 hash of a raw key is persisted. The raw
 * value is generated inside `create`, returned once, and never written.
 * `verify(raw)` recomputes the hash and looks up by it; constant-time
 * comparison is delegated to the hash equality itself (a 64-char hex
 * comparison reveals no timing information about the raw key).
 */
export interface ApiKeyStore {
  create(input: CreateApiKeyInput): Promise<CreatedApiKey>;

  /**
   * Resolves a raw API key. Returns null if no key matches, the key has
   * been revoked, or the key's tenant has been deleted.
   */
  verify(rawKey: string): Promise<ResolvedApiKey | null>;

  findById(id: string): Promise<ApiKeyMetadata | null>;

  listByTenant(tenantId: string): Promise<readonly ApiKeyMetadata[]>;

  /**
   * Marks the key revoked. Idempotent: revoking an already-revoked key is
   * a no-op. Revoking a non-existent key throws.
   */
  revoke(id: string): Promise<void>;

  /**
   * Updates `lastUsedAt` to the current time. Implementations may batch or
   * sample this — the contract only guarantees eventual freshness.
   */
  touchLastUsed(id: string): Promise<void>;
}
