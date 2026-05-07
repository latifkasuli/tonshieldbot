import type { CachedFetch, FetchCache } from "./types.ts";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_SIZE = 500;

export interface TtlCacheOptions {
  readonly ttlMs?: number;
  readonly maxSize?: number;
}

export class TtlFetchCache implements FetchCache {
  private readonly store = new Map<string, CachedFetch>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(options: TtlCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  }

  get(url: string): CachedFetch | undefined {
    const entry = this.store.get(url);

    if (entry === undefined) {
      return undefined;
    }

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.store.delete(url);
      return undefined;
    }

    return entry;
  }

  set(url: string, value: CachedFetch): void {
    if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;

      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }

    this.store.set(url, value);
  }
}
