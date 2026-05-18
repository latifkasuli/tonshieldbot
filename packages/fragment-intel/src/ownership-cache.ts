import type { UsernameOwnership, UsernameOwnershipResult } from "./username-lookup.ts";

/**
 * In-memory TTL cache for Fragment username ownership lookups. Sits in
 * front of `lookupUsernameOwnership` so a single scan that touches the
 * same username through multiple paths (pasted handle, resolved
 * entity's username) doesn't issue duplicate TONAPI calls.
 *
 * What we cache:
 *   - `ok` results — useful for the next scan within TTL.
 *   - `not_found` results — these are stable enough at TONAPI's
 *     resolution layer that caching them for a short window prevents
 *     a hot non-Fragment handle (every random `@somehandle` we scan)
 *     from costing a TONAPI roundtrip every time.
 *
 * What we DON'T cache:
 *   - `disabled` (cheap to recompute, status flips with config).
 *   - `failed` (we WANT to retry on the next scan; caching a transient
 *     failure would mask recovery).
 *
 * The cache is intentionally tiny and dependency-free. A Postgres-
 * backed cache (with longer TTL, multi-process sharing) is the natural
 * upgrade path once we see Fragment lookups in production traffic.
 */

export interface OwnershipCacheOptions {
  /** TTL in milliseconds. Default 5 minutes. */
  readonly ttlMs?: number;
  /** Max entries before LRU eviction. Default 1000. */
  readonly maxEntries?: number;
  /** Inject `now()` for tests. Defaults to `Date.now`. */
  readonly now?: () => Date;
}

export interface OwnershipCache {
  get(username: string): UsernameOwnershipResult | null;
  set(username: string, result: UsernameOwnershipResult): void;
  /** Number of entries currently held. Diagnostic only. */
  readonly size: () => number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1_000;

interface Entry {
  readonly result: UsernameOwnershipResult;
  readonly expiresAt: number;
}

export const createOwnershipCache = (options: OwnershipCacheOptions = {}): OwnershipCache => {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? (() => new Date());

  // Map preserves insertion order — we use it for both lookup AND
  // simple LRU eviction (delete + re-set on hit moves the entry to the
  // end).
  const entries = new Map<string, Entry>();

  const evictExpired = (): void => {
    const t = now().getTime();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= t) {
        entries.delete(key);
      }
    }
  };

  return {
    get(username) {
      const entry = entries.get(username);
      if (entry === undefined) return null;
      if (entry.expiresAt <= now().getTime()) {
        entries.delete(username);
        return null;
      }
      // LRU bump: move to most-recent.
      entries.delete(username);
      entries.set(username, entry);
      return entry.result;
    },
    set(username, result) {
      if (!shouldCache(result)) return;
      evictExpired();
      if (entries.size >= maxEntries) {
        // Drop the oldest entry. Map iteration is insertion order,
        // and we re-insert on hit, so the first key is the LRU.
        const oldestKey = entries.keys().next().value;
        if (oldestKey !== undefined) entries.delete(oldestKey);
      }
      entries.set(username, { result, expiresAt: now().getTime() + ttlMs });
    },
    size: () => entries.size,
  };
};

const shouldCache = (result: UsernameOwnershipResult): boolean =>
  result.status === "ok" || result.status === "not_found";

/**
 * Convenience for narrowing an "ok" cached result back to the
 * ownership payload. Returns `null` for any other status. Used in
 * tests; not load-bearing for production callers.
 */
export const ownershipOrNull = (
  result: UsernameOwnershipResult | null,
): UsernameOwnership | null => {
  if (result === null) return null;
  return result.status === "ok" ? result.ownership : null;
};
