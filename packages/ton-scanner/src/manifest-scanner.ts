import { createFinding, getCoreRule } from "@tonshield/risk-engine";
import type { RiskFinding } from "@tonshield/shared";
import type { FetchCache } from "@tonshield/safe-fetch";
import { safeFetch } from "@tonshield/safe-fetch";
import { scanManifestIdentity } from "./manifest-identity.ts";
import { parseTonConnectManifest } from "./manifest.ts";
import type { TonConnectManifest } from "./manifest.ts";

const JSON_CONTENT_TYPES = /^(?:application\/json|application\/[\w.+-]+\+json)(?:\s*;|$)/i;

export interface ManifestScanResult {
  readonly findings: readonly RiskFinding[];
  readonly manifest: TonConnectManifest | null;
}

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

  if (!isAcceptableManifestContent(contentType)) {
    findings.push(
      createFinding({
        confidence: "high",
        evidence: { contentType },
        rule: getCoreRule("TONCONNECT_MANIFEST_CONTENT_SUSPICIOUS"),
      }),
    );

    if (contentType?.toLowerCase().includes("text/html") === true) {
      return { findings, manifest: null };
    }
  }

  if (!body.trimStart().startsWith("{")) {
    findings.push(
      createFinding({
        confidence: "high",
        evidence: { reason: "body_not_json_object" },
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
        evidence: { parseError: parseResult.error },
        rule: getCoreRule("TONCONNECT_MANIFEST_INVALID"),
      }),
    );

    return { findings, manifest: null };
  }

  const manifest = parseResult.value;
  findings.push(...scanManifestIdentity(manifestUrl, fetchResult.value.finalUrl, manifest));

  return { findings, manifest };
};

const isAcceptableManifestContent = (contentType: string | null): boolean =>
  contentType === null || JSON_CONTENT_TYPES.test(contentType);
