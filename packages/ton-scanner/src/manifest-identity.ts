import { createFinding, getCoreRule } from "@tonshield/risk-engine";
import type { RiskFinding } from "@tonshield/shared";
import { detectDomainImpersonation, detectNameImpersonation } from "./impersonation.ts";
import { getRegistrableDomain } from "./impersonation.ts";
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
 * The TON Connect spec describes a recommended placement (`/<root>/tonconnect-
 * manifest.json` on the app's origin), but the SDK explicitly permits hosting on
 * any host — see https://github.com/ton-connect/sdk/issues/82. So exact-origin
 * equality is not a protocol invariant; the policy below balances that against
 * the security need to catch attacker redirects.
 *
 * Origin policy (in resolution order against `finalUrl` and the manifest's
 * declared `url`):
 *
 *   1. Same origin → no finding.
 *   2. Same registrable domain (e.g. `app.dedust.io` vs `dedust.io`,
 *      `www.example.com` vs `example.com`) → no finding. Subdomain layout is
 *      a normal SPA pattern.
 *   3. Different registrable domain, served at the input URL with no cross-
 *      origin redirect → `TONCONNECT_MANIFEST_EXTERNAL_HOST` (low). The user
 *      pasted a manifest URL on a CDN-style host that is not associated with
 *      the declared app; allowed by the SDK but worth flagging.
 *   4. Cross-origin redirect AND the final host is on a different registrable
 *      domain than the declared app → `TONCONNECT_MANIFEST_ORIGIN_MISMATCH`
 *      (high). This is the redirect-attack shape: pasted URL on a trusted
 *      origin, redirect target serves a manifest claiming the trusted origin.
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
  const followedCrossOriginRedirect = manifestUrl.origin !== finalUrl.origin;

  findings.push(...scanOriginPolicy(manifestUrl, finalUrl, manifest, followedCrossOriginRedirect));
  findings.push(...scanImpersonation(manifestUrl, finalUrl, manifest));

  return findings;
};

const scanOriginPolicy = (
  manifestUrl: URL,
  finalUrl: URL,
  manifest: TonConnectManifest,
  followedCrossOriginRedirect: boolean,
): readonly RiskFinding[] => {
  const declaredAppOrigin = manifest.url.origin;
  const manifestOrigin = finalUrl.origin;

  if (manifestOrigin === declaredAppOrigin) {
    return [];
  }

  const finalRd = getRegistrableDomain(finalUrl.hostname);
  const declaredRd = getRegistrableDomain(manifest.url.hostname);

  // Fall back to strict origin comparison when either host can't be
  // parsed as a registrable domain (e.g. raw IPs, single-label hosts).
  // Treating those as unknown and conservative is safer than allowing
  // an attacker to bypass the check via a non-public-suffix hostname.
  const cannotCompareRd = finalRd === null || declaredRd === null;
  const sameRegistrableDomain = !cannotCompareRd && finalRd === declaredRd;

  if (sameRegistrableDomain) {
    return [];
  }

  const evidence = {
    declaredAppOrigin,
    declaredRegistrableDomain: declaredRd,
    finalRegistrableDomain: finalRd,
    followedCrossOriginRedirect,
    inputOrigin: manifestUrl.origin,
    manifestOrigin,
  };

  // The combination of (cross-origin redirect + final host on a foreign RD) is
  // the redirect-attack shape — keep the high-severity finding. Also covers
  // the unparseable-RD fallback because we can't prove the redirect is benign.
  if (cannotCompareRd || followedCrossOriginRedirect) {
    return [
      createFinding({
        confidence: "high",
        evidence,
        rule: getCoreRule("TONCONNECT_MANIFEST_ORIGIN_MISMATCH"),
      }),
    ];
  }

  // Manifest was fetched directly from a host outside the declared app's
  // registrable domain, with no redirect. Allowed by the SDK; emit the
  // lower-severity signal so users still see it in their report.
  return [
    createFinding({
      confidence: "high",
      evidence,
      rule: getCoreRule("TONCONNECT_MANIFEST_EXTERNAL_HOST"),
    }),
  ];
};

const scanImpersonation = (
  manifestUrl: URL,
  finalUrl: URL,
  manifest: TonConnectManifest,
): readonly RiskFinding[] => {
  const findings: RiskFinding[] = [];
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
