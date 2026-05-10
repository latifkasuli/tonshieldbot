import { createFinding, getCoreRule } from "@tonshield/risk-engine";
import type { RiskFinding } from "@tonshield/shared";
import type { FetchCache } from "@tonshield/safe-fetch";
import { safeFetch } from "@tonshield/safe-fetch";
import { scanManifestIdentity } from "./manifest-identity.ts";
import { parseTonConnectManifest } from "./manifest.ts";
import type { TonConnectManifest } from "./manifest.ts";

const HTML_CONTENT_TYPE = /^\s*text\/html\b/i;

export interface ManifestScanResult {
  readonly findings: readonly RiskFinding[];
  readonly manifest: TonConnectManifest | null;
}

/**
 * Scans a TON Connect manifest URL.
 *
 * Body shape is the source of truth, not the `Content-Type` header. Some
 * legitimate projects (e.g. Tonkeeper at the time of writing) serve the
 * manifest with `text/html` from a CDN configured for HTML. The TON Connect
 * spec describes the file as JSON but does not require a strict
 * `application/json` header. Penalising a parseable, schema-valid manifest
 * because of its header alone produces noisy false positives on real apps.
 *
 * Resolution order:
 *   1. Body parses as a valid TON Connect manifest → run identity checks,
 *      no `CONTENT_SUSPICIOUS` finding regardless of `Content-Type`.
 *   2. Body looks like HTML (or `Content-Type` says `text/html` and the body
 *      is not a JSON object) → emit `CONTENT_SUSPICIOUS`. The server is
 *      returning a page, not a manifest.
 *   3. Body otherwise fails to parse → emit `MANIFEST_INVALID`.
 */
export const scanTonConnectManifest = async (
  manifestUrl: URL,
  cache?: FetchCache,
): Promise<ManifestScanResult> => {
  const findings: RiskFinding[] = [];
  const fetchResult = await safeFetch(manifestUrl, cache === undefined ? {} : { cache });

  if (!fetchResult.ok) {
    findings.push(
      createFinding({
        confidence: "high",
        evidence: { error: fetchResult.error, url: manifestUrl.toString() },
        rule:
          fetchResult.error === "ssrf_blocked"
            ? getCoreRule("TONCONNECT_MANIFEST_SSRF_BLOCKED")
            : getCoreRule("TONCONNECT_MANIFEST_FETCH_FAILED"),
      }),
    );

    return { findings, manifest: null };
  }

  const { body, contentType } = fetchResult.value;
  const trimmed = body.trimStart();
  const looksLikeJsonObject = trimmed.startsWith("{");
  const looksLikeHtml = trimmed.startsWith("<");
  const claimsHtml = contentType !== null && HTML_CONTENT_TYPE.test(contentType);

  // A non-JSON body served as HTML — or any body that visibly starts with `<` —
  // is a server error page or a misconfigured route, not a manifest. Bail
  // before attempting to parse.
  if (!looksLikeJsonObject) {
    if (looksLikeHtml || claimsHtml) {
      findings.push(
        createFinding({
          confidence: "high",
          evidence: { contentType, bodyShape: looksLikeHtml ? "html" : "non_json" },
          rule: getCoreRule("TONCONNECT_MANIFEST_CONTENT_SUSPICIOUS"),
        }),
      );

      return { findings, manifest: null };
    }

    findings.push(
      createFinding({
        confidence: "high",
        evidence: { reason: "body_not_json_object", contentType },
        rule: getCoreRule("TONCONNECT_MANIFEST_INVALID"),
      }),
    );

    return { findings, manifest: null };
  }

  const parseResult = parseTonConnectManifest(body);

  if (!parseResult.ok) {
    findings.push(
      createFinding({
        confidence: "high",
        evidence: { parseError: parseResult.error, contentType },
        rule: getCoreRule("TONCONNECT_MANIFEST_INVALID"),
      }),
    );

    return { findings, manifest: null };
  }

  const manifest = parseResult.value;
  findings.push(...scanManifestIdentity(manifestUrl, fetchResult.value.finalUrl, manifest));

  return { findings, manifest };
};
