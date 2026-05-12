import { z } from "zod";
import credentialPhishingRaw from "../data/keywords/credential-phishing.json" with { type: "json" };
import lureLanguageRaw from "../data/keywords/lure-language.json" with { type: "json" };

/**
 * Pure content analyzer for Mini App / web-page HTML bodies. Detects:
 *
 *   1. Credential-phishing keywords (seed phrase, login code, 2FA, private
 *      key) — absolute red flags. Legitimate Mini Apps never prompt for
 *      these. Multilingual: EN/RU/ES/ZH per Kaspersky 2025 Mini App
 *      report.
 *   2. Lure language (airdrop claim, gift unlock, wallet verify, gift
 *      upgrade-fee, urgency pressure) — softer signals. Legitimate
 *      marketing CAN use similar language, so this fires at medium
 *      severity unless paired with another tier-1 finding.
 *   3. APK download links — Mini App page that also serves an Android
 *      package is the documented FEMITBOT pattern. Critical regardless
 *      of context.
 *
 * Why a pure module: I/O (safe-fetch) happens at the scanner layer in
 * `@tonshield/ton-scanner` where it already has rate-limit and SSRF
 * controls. This module is fully unit-testable with fixture HTML strings.
 *
 * Match algorithm: lowercase substring match. Works for all four target
 * languages — EN/RU/ES use spaces but the keyword set is phrase-shaped
 * (not single-word), and ZH is space-less so substring is the only
 * option. Matched-phrase length is reported in evidence so consumers can
 * weight short-vs-long matches.
 */

const keywordCategorySchema = z.object({
  category: z.string(),
  severity: z.enum(["medium", "high", "critical"]),
  keywords_en: z.array(z.string().min(2)),
  keywords_ru: z.array(z.string().min(2)),
  keywords_es: z.array(z.string().min(2)),
  keywords_zh: z.array(z.string().min(2)),
});

const keywordFileSchema = z.object({
  description: z.string(),
  sources: z.array(z.string()),
  categories: z.array(keywordCategorySchema).min(1),
});

export type KeywordSeverity = "medium" | "high" | "critical";

interface CompiledKeyword {
  readonly category: string;
  readonly severity: KeywordSeverity;
  readonly language: "en" | "ru" | "es" | "zh";
  readonly phrase: string;
}

const compile = (raw: unknown): readonly CompiledKeyword[] => {
  const parsed = keywordFileSchema.parse(raw);
  const compiled: CompiledKeyword[] = [];
  for (const cat of parsed.categories) {
    for (const phrase of cat.keywords_en)
      compiled.push({
        category: cat.category,
        severity: cat.severity,
        language: "en",
        phrase: phrase.toLowerCase(),
      });
    for (const phrase of cat.keywords_ru)
      compiled.push({
        category: cat.category,
        severity: cat.severity,
        language: "ru",
        phrase: phrase.toLowerCase(),
      });
    for (const phrase of cat.keywords_es)
      compiled.push({
        category: cat.category,
        severity: cat.severity,
        language: "es",
        phrase: phrase.toLowerCase(),
      });
    for (const phrase of cat.keywords_zh)
      compiled.push({
        category: cat.category,
        severity: cat.severity,
        language: "zh",
        phrase: phrase.toLowerCase(),
      });
  }
  return compiled;
};

const CREDENTIAL_PHISHING_KEYWORDS = compile(credentialPhishingRaw);
const LURE_LANGUAGE_KEYWORDS = compile(lureLanguageRaw);

export interface KeywordMatch {
  readonly category: string;
  readonly severity: KeywordSeverity;
  readonly language: "en" | "ru" | "es" | "zh";
  readonly phrase: string;
}

export interface ApkLink {
  /** Full href as it appeared on the page. */
  readonly href: string;
  /** Filename extracted from the URL (last path segment) if recognisable. */
  readonly filename: string | null;
}

export interface MiniAppContentReport {
  /** All credential-phishing keyword hits (deduplicated by exact phrase). */
  readonly credentialPhishingMatches: readonly KeywordMatch[];
  /** All lure-language keyword hits (deduplicated by exact phrase). */
  readonly lureMatches: readonly KeywordMatch[];
  /** APK links discovered in the page body. */
  readonly apkLinks: readonly ApkLink[];
  /** Set of unique languages observed (informational; for evidence rendering). */
  readonly languagesSeen: readonly ("en" | "ru" | "es" | "zh")[];
}

/**
 * Analyze a fetched HTML body for Mini App phishing signals. Returns a
 * report; the caller (`scanner.ts`) maps it to findings.
 *
 * The analyzer does NOT parse HTML — it operates on the raw body text.
 * This is intentional: scam pages frequently use minified/obfuscated
 * markup, and a permissive substring match catches more than strict
 * DOM-parsing would. For APK link detection we use a regex over href
 * attribute values, which is the one structured signal that benefits
 * from light parsing.
 */
export const analyseMiniAppContent = (htmlBody: string): MiniAppContentReport => {
  const lowered = htmlBody.toLowerCase();

  const credentialPhishingMatches = matchKeywords(lowered, CREDENTIAL_PHISHING_KEYWORDS);
  const lureMatches = matchKeywords(lowered, LURE_LANGUAGE_KEYWORDS);
  const apkLinks = extractApkLinks(htmlBody);

  const languagesSeen = new Set<"en" | "ru" | "es" | "zh">();
  for (const m of credentialPhishingMatches) languagesSeen.add(m.language);
  for (const m of lureMatches) languagesSeen.add(m.language);

  return {
    credentialPhishingMatches,
    lureMatches,
    apkLinks,
    languagesSeen: Array.from(languagesSeen),
  };
};

// ── keyword matching ──────────────────────────────────────────────────────

const matchKeywords = (
  loweredBody: string,
  keywords: readonly CompiledKeyword[],
): readonly KeywordMatch[] => {
  const seen = new Set<string>();
  const matches: KeywordMatch[] = [];
  for (const kw of keywords) {
    if (seen.has(kw.phrase)) continue;
    if (loweredBody.includes(kw.phrase)) {
      seen.add(kw.phrase);
      matches.push({
        category: kw.category,
        severity: kw.severity,
        language: kw.language,
        phrase: kw.phrase,
      });
    }
  }
  return matches;
};

// ── APK detection ─────────────────────────────────────────────────────────

/**
 * Find `.apk` references in the body. Two patterns the FEMITBOT-class
 * campaigns use:
 *   - `<a href="*.apk">` direct download links
 *   - `<a href="*.apk?...">` with query strings (CDN-served downloads)
 *
 * Note we DON'T require quoting on the href — minified or obfuscated
 * pages may use single-quoted, unquoted, or `data-*` attribute carriers.
 * Match anything that looks like a URL ending in `.apk` (with optional
 * query/fragment) inside the body. Caller verifies the host vs the
 * Mini App origin.
 */
const APK_LINK_PATTERN = /\b((?:https?:)?\/\/[^\s"'<>]+?\.apk\b[^\s"'<>]*)/gi;

const extractApkLinks = (body: string): readonly ApkLink[] => {
  const links: ApkLink[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = APK_LINK_PATTERN.exec(body)) !== null) {
    const href = match[1];
    if (href === undefined || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, filename: extractFilename(href) });
  }
  return links;
};

const extractFilename = (href: string): string | null => {
  const stripped = href.split(/[?#]/)[0] ?? href;
  const lastSegment = stripped.split("/").pop();
  if (lastSegment === undefined || lastSegment.length === 0) return null;
  return lastSegment.toLowerCase().endsWith(".apk") ? lastSegment : null;
};
