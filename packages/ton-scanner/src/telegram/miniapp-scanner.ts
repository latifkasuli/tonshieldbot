import { createFinding, getCoreRule } from "@tonshield/risk-engine";
import type { ActionPreview, RiskFinding } from "@tonshield/shared";
import type { FetchCache } from "@tonshield/safe-fetch";
import { safeFetch } from "@tonshield/safe-fetch";
import {
  analyseMiniAppContent,
  type ApkLink,
  type KeywordMatch,
  type MiniAppContentReport,
} from "@tonshield/telegram-intel";

/**
 * Scanner for Mini App / web-page content. Fetches the URL via
 * `@tonshield/safe-fetch` (SSRF-hardened, byte-capped, no JS execution
 * per design §9 Q4) and runs the pure content analyzer.
 *
 * Emits up to three findings:
 *   - `TELEGRAM_MINIAPP_CREDENTIAL_PHISHING` (critical, +80) when any
 *     seed-phrase / login-code / 2FA / private-key keyword matches.
 *   - `TELEGRAM_MINIAPP_APK_DOWNLOAD` (critical, +80) when the body
 *     contains a `.apk` link.
 *   - `TELEGRAM_MINIAPP_LURE_LANGUAGE` (medium, +25) when softer
 *     airdrop/gift/verification lures match.
 *
 * On fetch failure the scanner degrades silently (no findings) — we
 * don't want every transient 404 to produce a finding. The user can
 * always re-submit. (Compare with the M2 TONAPI failure-classification:
 * different posture because Bot API rates are per-token, while web
 * fetches are per-URL and routinely fail for reasons unrelated to the
 * target.)
 */

export interface MiniAppScanResult {
  readonly findings: readonly RiskFinding[];
  readonly actions: readonly ActionPreview[];
  /**
   * The raw content report when a fetch succeeded. Useful for tests and
   * for the API to optionally expose alongside findings.
   */
  readonly report: MiniAppContentReport | null;
}

const EMPTY_RESULT: MiniAppScanResult = { findings: [], actions: [], report: null };

/**
 * Fetch a URL and run the Mini App content analyzer. The URL is treated
 * as Mini-App-shaped because the caller (basic-scan) only invokes this
 * for `generic_url` and `telegram_miniapp_url` kinds.
 */
export const scanMiniAppContent = async (
  url: URL,
  cache?: FetchCache,
): Promise<MiniAppScanResult> => {
  const fetchResult = await safeFetch(url, cache === undefined ? {} : { cache });

  if (!fetchResult.ok) {
    // Silent degradation. A fetch failure here doesn't tell us anything
    // about the user — could be a 404, DNS hiccup, byte cap exceeded
    // (Mini App pages can be large), or SSRF block. Returning EMPTY_RESULT
    // means the report stays clean for legitimate sites that we couldn't
    // reach and lets the user retry.
    return EMPTY_RESULT;
  }

  const report = analyseMiniAppContent(fetchResult.value.body);
  const findings: RiskFinding[] = [];

  if (report.credentialPhishingMatches.length > 0) {
    findings.push(
      createFinding({
        confidence: "high",
        evidence: keywordEvidence(
          url,
          fetchResult.value.finalUrl,
          report.credentialPhishingMatches,
          report.languagesSeen,
        ),
        rule: getCoreRule("TELEGRAM_MINIAPP_CREDENTIAL_PHISHING"),
      }),
    );
  }

  if (report.apkLinks.length > 0) {
    findings.push(
      createFinding({
        confidence: "high",
        evidence: apkEvidence(url, fetchResult.value.finalUrl, report.apkLinks),
        rule: getCoreRule("TELEGRAM_MINIAPP_APK_DOWNLOAD"),
      }),
    );
  }

  if (report.lureMatches.length > 0) {
    findings.push(
      createFinding({
        confidence: report.credentialPhishingMatches.length > 0 ? "high" : "medium",
        evidence: keywordEvidence(
          url,
          fetchResult.value.finalUrl,
          report.lureMatches,
          report.languagesSeen,
        ),
        rule: getCoreRule("TELEGRAM_MINIAPP_LURE_LANGUAGE"),
      }),
    );
  }

  return { findings, actions: [], report };
};

const keywordEvidence = (
  requestedUrl: URL,
  finalUrl: URL,
  matches: readonly KeywordMatch[],
  languagesSeen: readonly ("en" | "ru" | "es" | "zh")[],
): Readonly<Record<string, unknown>> => ({
  url: finalUrl.toString(),
  ...(finalUrl.toString() === requestedUrl.toString()
    ? {}
    : { requestedUrl: requestedUrl.toString() }),
  matchedCount: matches.length,
  // Cap the per-match list at 20 — beyond that, the evidence becomes
  // unwieldy without adding signal. Operators can fetch the full content
  // report from the scanner if they need it.
  matches: matches.slice(0, 20).map((m) => ({
    category: m.category,
    severity: m.severity,
    language: m.language,
    phrase: m.phrase,
  })),
  languagesSeen,
});

const apkEvidence = (
  requestedUrl: URL,
  finalUrl: URL,
  apkLinks: readonly ApkLink[],
): Readonly<Record<string, unknown>> => ({
  url: finalUrl.toString(),
  ...(finalUrl.toString() === requestedUrl.toString()
    ? {}
    : { requestedUrl: requestedUrl.toString() }),
  apkCount: apkLinks.length,
  // Capture up to 5 links — usually only 1 in practice, but the FEMITBOT
  // network rotates filenames so multiple references on one page are
  // plausible.
  apkLinks: apkLinks.slice(0, 5).map((link) => ({
    href: link.href,
    filename: link.filename,
  })),
});
