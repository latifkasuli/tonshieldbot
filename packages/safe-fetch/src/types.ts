import type { Result } from "@tonshield/shared";

export type SafeFetchError =
  | "https_required"
  | "ssrf_blocked"
  | "fetch_timeout"
  | "fetch_failed"
  | "too_many_redirects"
  | "response_too_large";

export interface SafeFetchSuccess {
  readonly body: string;
  readonly contentType: string | null;
  readonly finalUrl: URL;
}

export type SafeFetchResult = Result<SafeFetchSuccess, SafeFetchError>;

export interface CachedFetch {
  readonly success: SafeFetchSuccess;
  readonly cachedAt: number;
}

export interface FetchCache {
  get(url: string): CachedFetch | undefined;
  set(url: string, value: CachedFetch): void;
}

export interface SafeFetchOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly cache?: FetchCache;
}
