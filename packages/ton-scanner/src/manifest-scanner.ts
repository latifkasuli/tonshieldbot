import { createFinding, getCoreRule } from "@tonshield/risk-engine";
import type { RiskFinding } from "@tonshield/shared";
import type { FetchCache } from "@tonshield/safe-fetch";
import { safeFetch } from "@tonshield/safe-fetch";
import { detectDomainImpersonation, detectNameImpersonation } from "./impersonation.ts";
import { checkManifestIdentity, parseTonConnectManifest } from "./manifest.ts";
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
  findings.push(...scanManifestIdentity(manifestUrl, manifest));

  return { findings, manifest };
};

const isAcceptableManifestContent = (contentType: string | null): boolean =>
  contentType === null || JSON_CONTENT_TYPES.test(contentType);

const scanManifestIdentity = (
  manifestUrl: URL,
  manifest: TonConnectManifest,
): readonly RiskFinding[] => {
  const findings: RiskFinding[] = [];
  const identity = checkManifestIdentity(manifestUrl, manifest);

  if (identity.hasOriginMismatch) {
    findings.push(
      createFinding({
        confidence: "high",
        evidence: {
          declaredAppOrigin: identity.declaredAppOrigin,
          manifestOrigin: identity.manifestOrigin,
        },
        rule: getCoreRule("TONCONNECT_MANIFEST_ORIGIN_MISMATCH"),
      }),
    );
  }

  const domainMatches = [
    { hostname: manifestUrl.hostname, source: "manifest_url" },
    { hostname: manifest.url.hostname, source: "declared_app_url" },
  ] as const;

  for (const candidate of domainMatches) {
    const match = detectDomainImpersonation(candidate.hostname);

    if (match !== null) {
      findings.push(
        createFinding({
          confidence: match.confidence,
          evidence: {
            hostname: candidate.hostname,
            matchKind: match.matchKind,
            source: candidate.source,
            suspectedProject: match.project.displayName,
          },
          rule: getCoreRule("TONCONNECT_PROJECT_IMPERSONATION"),
        }),
      );
    }
  }

  const nameMatch = detectNameImpersonation(manifest.name, manifestUrl.hostname);

  if (nameMatch !== null) {
    findings.push(
      createFinding({
        confidence: nameMatch.confidence,
        evidence: {
          claimedName: manifest.name,
          hostingDomain: manifestUrl.hostname,
          matchKind: nameMatch.matchKind,
          suspectedProject: nameMatch.project.displayName,
        },
        rule: getCoreRule("TONCONNECT_PROJECT_IMPERSONATION"),
      }),
    );
  }

  return findings;
};
