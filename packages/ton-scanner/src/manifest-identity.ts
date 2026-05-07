import { createFinding, getCoreRule } from "@tonshield/risk-engine";
import type { RiskFinding } from "@tonshield/shared";
import { detectDomainImpersonation, detectNameImpersonation } from "./impersonation.ts";
import { checkManifestIdentity } from "./manifest.ts";
import type { TonConnectManifest } from "./manifest.ts";

interface ImpersonationCandidate {
  readonly hostname: string;
  readonly source: "manifest_url" | "final_url" | "declared_app_url";
}

/**
 * Scans manifest identity against the URL the manifest was actually served from
 * (`finalUrl`), not just the URL the user pasted (`manifestUrl`). After redirects
 * those can differ, and a self-consistent manifest hosted at the redirect target
 * would otherwise bypass the origin-mismatch check.
 *
 * Impersonation runs against every hostname the user is exposed to: the input,
 * the final served URL, and the declared app URL. Identical hostnames are deduped.
 *
 * This module is deliberately free of any I/O and any transitive `safe-fetch`
 * imports so it can be unit-tested without bringing in `undici`.
 */
export const scanManifestIdentity = (
  manifestUrl: URL,
  finalUrl: URL,
  manifest: TonConnectManifest,
): readonly RiskFinding[] => {
  const findings: RiskFinding[] = [];
  const identity = checkManifestIdentity(finalUrl, manifest);
  const followedCrossOriginRedirect = manifestUrl.origin !== finalUrl.origin;

  if (identity.hasOriginMismatch) {
    findings.push(
      createFinding({
        confidence: "high",
        evidence: {
          declaredAppOrigin: identity.declaredAppOrigin,
          followedCrossOriginRedirect,
          inputOrigin: manifestUrl.origin,
          manifestOrigin: identity.manifestOrigin,
        },
        rule: getCoreRule("TONCONNECT_MANIFEST_ORIGIN_MISMATCH"),
      }),
    );
  }

  const candidates: readonly ImpersonationCandidate[] = dedupeByHostname([
    { hostname: manifestUrl.hostname, source: "manifest_url" },
    { hostname: finalUrl.hostname, source: "final_url" },
    { hostname: manifest.url.hostname, source: "declared_app_url" },
  ]);

  for (const candidate of candidates) {
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

  // Name impersonation checks against the hostname that *served* the manifest:
  // a manifest claiming "Tonkeeper" is suspicious based on where it actually
  // lives, not where the user thought it lived.
  const nameMatch = detectNameImpersonation(manifest.name, finalUrl.hostname);

  if (nameMatch !== null) {
    findings.push(
      createFinding({
        confidence: nameMatch.confidence,
        evidence: {
          claimedName: manifest.name,
          hostingDomain: finalUrl.hostname,
          matchKind: nameMatch.matchKind,
          suspectedProject: nameMatch.project.displayName,
        },
        rule: getCoreRule("TONCONNECT_PROJECT_IMPERSONATION"),
      }),
    );
  }

  return findings;
};

const dedupeByHostname = (
  candidates: readonly ImpersonationCandidate[],
): readonly ImpersonationCandidate[] => {
  const seen = new Set<string>();
  const unique: ImpersonationCandidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.hostname)) {
      continue;
    }

    seen.add(candidate.hostname);
    unique.push(candidate);
  }

  return unique;
};
