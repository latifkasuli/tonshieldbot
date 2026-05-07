import { describe, expect, it } from "vitest";
import { TtlFetchCache, safeFetch } from "../src/index.ts";
import type { CachedFetch } from "../src/types.ts";

/**
 * Smoke + integration tests for `safeFetch`.
 *
 * Two purposes:
 *   1. Importing this file forces `safeFetch` (and transitively `undici`) to
 *      load and construct its module-level Agent. If undici regresses on the
 *      pinned Node version, CI catches it here rather than only at runtime in
 *      the manifest scanner.
 *   2. Exercise real error paths through the function so we know the connector,
 *      IP validator, and Result mapping are wired correctly.
 *
 * Happy-path/redirect/size-limit testing requires a local HTTPS server and is
 * deferred to a dedicated integration test file.
 */
describe("safeFetch", () => {
  it("rejects non-https URLs with https_required", async () => {
    const result = await safeFetch(new URL("http://example.com/manifest.json"));

    expect(result).toEqual({ ok: false, error: "https_required" });
  });

  it("blocks IPv4 loopback addresses via SSRF guard", async () => {
    const result = await safeFetch(new URL("https://127.0.0.1/manifest.json"));

    expect(result).toEqual({ ok: false, error: "ssrf_blocked" });
  });

  it("blocks RFC1918 private addresses via SSRF guard", async () => {
    const result = await safeFetch(new URL("https://10.0.0.1/manifest.json"));

    expect(result).toEqual({ ok: false, error: "ssrf_blocked" });
  });

  it("blocks the AWS-style metadata IP", async () => {
    // 169.254.169.254 is the canonical cloud metadata endpoint.
    const result = await safeFetch(new URL("https://169.254.169.254/latest/meta-data/"));

    expect(result).toEqual({ ok: false, error: "ssrf_blocked" });
  });

  it("returns a cached entry without performing a network call", async () => {
    const cache = new TtlFetchCache();
    const url = new URL("https://example.com/cached.json");
    const cached: CachedFetch = {
      cachedAt: Date.now(),
      success: {
        body: '{"name":"cached"}',
        contentType: "application/json",
        finalUrl: url,
      },
    };
    cache.set(url.toString(), cached);

    const result = await safeFetch(url, { cache });

    expect(result).toEqual({ ok: true, value: cached.success });
  });
});
