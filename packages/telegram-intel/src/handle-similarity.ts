import { rectifyConfusion } from "unicode-confusables";

/**
 * Handle / display-name similarity engine for M3 PR-3. Pure, deterministic,
 * fully unit-testable.
 *
 * Normalisation pipeline (per docs/research/m3-design.md §6):
 *
 *   input → NFKC normalize → strip zero-width chars → TR39 skeleton (via
 *     `unicode-confusables.rectifyConfusion`) → casefold
 *
 * Similarity decision (also §6):
 *
 *   exact skeleton match                                  → "exact"
 *   damerau_levenshtein(skeleton, watch) ≤ 1              → "near"
 *   damerau_levenshtein == 2 AND jaro_winkler ≥ 0.92      → "similar"
 *   jaro_winkler ≥ 0.95 alone                             → "loose"
 *
 * The scanner fires `TELEGRAM_HANDLE_IMPERSONATES_PROJECT` /
 * `TELEGRAM_DISPLAY_NAME_HOMOGLYPH` for the first three tiers. `loose`
 * matches are returned but suppressed at the rule layer — they're too
 * false-positive to fire alone but the composer (later PR) can use them
 * when paired with another concurrent signal.
 *
 * Length sanity check: skip if `Math.max(a,b)/Math.min(a,b) > 2.0`. Keeps
 * us from comparing "Tonkeeper" to "Tony" and calling it a near-match.
 */

// ── normalisation ──────────────────────────────────────────────────────────

/**
 * Zero-width Unicode characters that visually disappear. Strip BEFORE
 * skeletoning. Built via escape sequences so the literal source stays
 * free of irregular whitespace:
 *
 *   U+200B ZERO WIDTH SPACE
 *   U+200C ZERO WIDTH NON-JOINER
 *   U+200D ZERO WIDTH JOINER
 *   U+FEFF ZERO WIDTH NO-BREAK SPACE (BOM)
 *   U+2060 WORD JOINER
 *   U+180E MONGOLIAN VOWEL SEPARATOR
 */
// Use alternation, not a character class, so the ZWJ U+200D doesn't trip
// eslint's `no-misleading-character-class` rule. The regex engine accepts
// the U+2060/U+180E codepoints either way.
const ZERO_WIDTH_CHARS = new RegExp("\u200B|\u200C|\u200D|\uFEFF|\u2060|\u180E", "g");

/**
 * Compute the TR39 confusables skeleton of an input string. Two strings
 * with the same skeleton are visually indistinguishable. Output is
 * lowercased and stripped of zero-width chars.
 */
export const normalize = (input: string): string => {
  // 1. NFKC: composes/decomposes per Unicode Normalization Form KC.
  //    Collapses presentation forms (e.g. fullwidth Latin → ASCII).
  // 2. Strip zero-width joiners/non-joiners/space/BOM/word-joiner/MVS —
  //    invisible glyphs scammers sprinkle to defeat exact-string matchers.
  // 3. TR39 skeleton — Cyrillic а→Latin a, Greek ο→o, etc.
  // 4. Casefold via `toLowerCase()`. For our handle/display-name inputs
  //    (predominantly Latin/Cyrillic/Greek), this is equivalent to a full
  //    casefold; we don't ship `.toLocaleLowerCase("en")` to keep the
  //    function deterministic regardless of operator locale.
  const stripped = input.normalize("NFKC").replace(ZERO_WIDTH_CHARS, "");
  return rectifyConfusion(stripped).toLowerCase();
};

// ── similarity primitives ──────────────────────────────────────────────────

/**
 * Damerau–Levenshtein edit distance: insert/delete/substitute + transpose-
 * of-adjacent. Implemented as a 2-row DP for O(n*m) time and O(min(n,m))
 * space. Symmetric.
 *
 * Tested against the canonical reference values (e.g. dlev("ca","abc") = 2).
 */
export const damerauLevenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const m = a.length;
  const n = b.length;
  // Three rolling rows: dp[k-2], dp[k-1], dp[k]. The transposition step
  // needs to look two rows back, hence three rows.
  const prev2 = new Array<number>(n + 1).fill(0);
  const prev1 = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j += 1) prev1[j] = j;

  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1, // insertion
        (prev1[j] ?? 0) + 1, // deletion
        (prev1[j - 1] ?? 0) + cost, // substitution
      );
      // Damerau transposition: adjacent swap.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        curr[j] = Math.min(curr[j] ?? 0, (prev2[j - 2] ?? 0) + 1);
      }
    }
    // Roll the rolling buffers forward.
    for (let j = 0; j <= n; j += 1) {
      prev2[j] = prev1[j] ?? 0;
      prev1[j] = curr[j] ?? 0;
    }
  }

  return prev1[n] ?? 0;
};

/**
 * Jaro similarity ∈ [0, 1]. Counts matching characters within a window and
 * applies a transposition penalty. Reference: Jaro (1989).
 */
export const jaro = (a: string, b: string): number => {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const maxDistance = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  const matchWindow = Math.max(0, maxDistance);

  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(b.length, i + matchWindow + 1);
    for (let j = start; j < end; j += 1) {
      if (bMatches[j] !== true && a[i] === b[j]) {
        aMatches[i] = true;
        bMatches[j] = true;
        matches += 1;
        break;
      }
    }
  }

  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (aMatches[i] !== true) continue;
    while (bMatches[k] !== true) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }

  return (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
};

/**
 * Jaro–Winkler similarity. Boosts the score for strings that share a
 * common prefix (up to 4 chars), reflecting that humans scan left-to-right
 * and tail-differences are easier to miss. `prefixWeight` defaults to 0.1
 * per Winkler's original paper.
 */
export const jaroWinkler = (a: string, b: string, prefixWeight = 0.1): number => {
  const j = jaro(a, b);
  if (j < 0.7) return j;

  const maxPrefix = 4;
  let l = 0;
  while (l < Math.min(a.length, b.length, maxPrefix) && a[l] === b[l]) l += 1;

  return j + l * prefixWeight * (1 - j);
};

// ── watchlist matching ────────────────────────────────────────────────────

/**
 * One curated brand entry from the watchlist. `match_keys` are skeleton-
 * normalised candidates we compare against (the brand name plus common
 * misspellings/variants seen in the wild). `legitimate_handles` are
 * handles known to be the actual brand — we skip the match for those.
 */
export interface BrandWatchlistEntry {
  readonly brand: string;
  readonly category:
    | "wallet"
    | "exchange"
    | "mini_app_platform"
    | "infra"
    | "marketplace"
    | "other";
  readonly matchKeys: readonly string[];
  readonly legitimateHandles: readonly string[];
  readonly notes?: string;
}

export type MatchStrength = "exact" | "near" | "similar" | "loose";

export interface WatchlistMatch {
  readonly brand: BrandWatchlistEntry;
  /** The match key that triggered (skeleton form). */
  readonly matchedKey: string;
  /** The candidate's skeleton form. */
  readonly candidateSkeleton: string;
  readonly strength: MatchStrength;
  readonly distance: number;
  readonly similarity: number;
}

/**
 * Compare a single candidate string against the entire watchlist and
 * return the strongest match (if any). Strongest = `exact` > `near` >
 * `similar` > `loose`; within a strength tier, the lowest distance wins;
 * ties broken by highest similarity.
 *
 * Returns `null` when no match meets even the `loose` threshold. Returns
 * `null` ALSO when the candidate's handle (lower-cased) is in the matched
 * brand's `legitimateHandles` — that's the brand itself, not an imposter.
 *
 * Tied scoring with the watchlist's own match keys is on the caller: a
 * candidate that equals a brand's `match_keys[0]` will return `strength:
 * "exact"`. The scanner suppresses the finding when the candidate is also
 * in `legitimateHandles`.
 */
export const matchAgainstWatchlist = (
  candidate: string,
  watchlist: readonly BrandWatchlistEntry[],
  options: { readonly candidateHandle?: string } = {},
): WatchlistMatch | null => {
  const candidateSkeleton = normalize(candidate);
  if (candidateSkeleton.length === 0) return null;

  let best: WatchlistMatch | null = null;

  for (const brand of watchlist) {
    // Skip if candidate handle is on the brand's legitimate list — that's
    // the real account, not impersonation. We compare lower-case raw
    // handle (without the leading @) to avoid skeleton-stripping the
    // legitimate handle (which might collide with itself).
    if (
      options.candidateHandle !== undefined &&
      brand.legitimateHandles.some(
        (h) => h.toLowerCase() === options.candidateHandle?.toLowerCase().replace(/^@/, ""),
      )
    ) {
      continue;
    }

    for (const matchKey of brand.matchKeys) {
      const keySkeleton = normalize(matchKey);
      if (keySkeleton.length === 0) continue;

      // Length sanity: ratio > 2.0 → skip. Avoids "tonkeeper" vs "ton"
      // collisions.
      const ratio =
        Math.max(candidateSkeleton.length, keySkeleton.length) /
        Math.min(candidateSkeleton.length, keySkeleton.length);
      if (ratio > 2.0) continue;

      const distance = damerauLevenshtein(candidateSkeleton, keySkeleton);
      const similarity = jaroWinkler(candidateSkeleton, keySkeleton);

      const strength = gradeMatch(distance, similarity, candidateSkeleton === keySkeleton);
      if (strength === null) continue;

      const match: WatchlistMatch = {
        brand,
        matchedKey: keySkeleton,
        candidateSkeleton,
        strength,
        distance,
        similarity,
      };

      if (best === null || isStronger(match, best)) {
        best = match;
      }
    }
  }

  return best;
};

const STRENGTH_ORDER: readonly MatchStrength[] = ["loose", "similar", "near", "exact"];

const gradeMatch = (
  distance: number,
  similarity: number,
  isExactSkeleton: boolean,
): MatchStrength | null => {
  if (isExactSkeleton) return "exact";
  if (distance <= 1) return "near";
  if (distance === 2 && similarity >= 0.92) return "similar";
  if (similarity >= 0.95) return "loose";
  return null;
};

const isStronger = (a: WatchlistMatch, b: WatchlistMatch): boolean => {
  const aRank = STRENGTH_ORDER.indexOf(a.strength);
  const bRank = STRENGTH_ORDER.indexOf(b.strength);
  if (aRank !== bRank) return aRank > bRank;
  if (a.distance !== b.distance) return a.distance < b.distance;
  return a.similarity > b.similarity;
};

/**
 * True when a match is firing-strength (exact / near / similar). Caller
 * for `TELEGRAM_HANDLE_IMPERSONATES_PROJECT` and
 * `TELEGRAM_DISPLAY_NAME_HOMOGLYPH` uses this to filter out `loose`
 * matches, which by themselves are too noisy and need pairing with
 * another concurrent signal (handled by a later composer PR).
 */
export const isFiringStrength = (match: WatchlistMatch): boolean =>
  match.strength === "exact" || match.strength === "near" || match.strength === "similar";
