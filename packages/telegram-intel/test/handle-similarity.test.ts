import { describe, expect, it } from "vitest";
import {
  damerauLevenshtein,
  isFiringStrength,
  jaro,
  jaroWinkler,
  matchAgainstWatchlist,
  matchTextAgainstWatchlist,
  normalize,
  type BrandWatchlistEntry,
} from "../src/handle-similarity.ts";
import { seedWatchlist } from "../src/watchlist.ts";

// ── normalize ─────────────────────────────────────────────────────────────

describe("normalize", () => {
  it("passes through pure ASCII unchanged (but lowercased)", () => {
    expect(normalize("Tonkeeper")).toBe("tonkeeper");
  });

  it("collapses Cyrillic confusables to Latin equivalents", () => {
    // Cyrillic Т (U+0422) and о (U+043E) look identical to Latin T/o.
    expect(normalize("Тоnkeeper")).toBe("tonkeeper");
  });

  it("collapses Greek confusables", () => {
    // Greek capital Α (U+0391) → Latin A.
    expect(normalize("Αpe")).toBe("ape");
  });

  it("strips zero-width characters before skeletoning", () => {
    // ZWSP, ZWNJ, ZWJ, BOM scattered through a handle. All invisible;
    // a scammer relies on the user seeing "tonkeeper". Constructed via
    // escape sequences so the test source itself stays free of irregular
    // whitespace.
    const adversarial =
      "t" +
      "\u200B" + // ZERO WIDTH SPACE
      "o" +
      "\u200C" + // ZERO WIDTH NON-JOINER
      "n" +
      "\u200D" + // ZERO WIDTH JOINER
      "k" +
      "\uFEFF" + // ZERO WIDTH NO-BREAK SPACE (BOM)
      "eeper";
    expect(normalize(adversarial)).toBe("tonkeeper");
  });

  it("normalises fullwidth Latin (NFKC) to ASCII", () => {
    // Fullwidth forms of Latin letters: U+FF34 (T), U+FF4F (o), etc.
    const fullwidth = "Ｔｏｎｋｅｅｐｅｒ";
    expect(normalize(fullwidth)).toBe("tonkeeper");
  });

  it("strips SOFT HYPHEN (U+00AD) — a Format-class char outside the zero-width cluster", () => {
    // SOFT HYPHEN is in Unicode category Cf, not the narrow zero-width
    // set. The original ZW-only list missed it. The \p{Cf} replacement
    // catches it. Regression for PR-3 review M1.
    const withSoftHyphen = "ton\u00ADkeeper";
    expect(normalize(withSoftHyphen)).toBe("tonkeeper");
  });

  it("strips bidi controls (LRM, RLM, ALM) — Trojan-Source-style evasion", () => {
    // U+200E LRM, U+200F RLM, U+061C ALM. All Cf-category, all invisible,
    // all usable to visually rearrange a string while keeping the bytes
    // looking benign. Regression for PR-3 review M1.
    const withBidi = "t\u200Eo\u200Fn\u061Ckeeper";
    expect(normalize(withBidi)).toBe("tonkeeper");
  });

  it("strips bidi isolates and embedding markers (U+202A–U+202E, U+2066–U+2069)", () => {
    // The Trojan-Source attack family (CVE-2021-42574) abuses these to
    // visually reorder identifier characters. We strip the entire Cf
    // category, so all of them go.
    const withIsolates = "ton\u2066\u202Akeeper\u202C\u2069";
    expect(normalize(withIsolates)).toBe("tonkeeper");
  });

  it("treats empty input as empty", () => {
    expect(normalize("")).toBe("");
  });
});

// ── Damerau–Levenshtein ───────────────────────────────────────────────────

describe("damerauLevenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(damerauLevenshtein("tonkeeper", "tonkeeper")).toBe(0);
  });

  it("returns the length of the other string when one is empty", () => {
    expect(damerauLevenshtein("", "abc")).toBe(3);
    expect(damerauLevenshtein("abc", "")).toBe(3);
  });

  it("counts a single substitution as distance 1", () => {
    expect(damerauLevenshtein("kitten", "kotten")).toBe(1);
  });

  it("counts a single insertion as distance 1", () => {
    expect(damerauLevenshtein("tonkeeper", "tonkeepers")).toBe(1);
  });

  it("counts a single deletion as distance 1", () => {
    expect(damerauLevenshtein("tonkeeper", "tonkeepe")).toBe(1);
  });

  it("counts a single transposition of adjacent chars as distance 1 (Damerau extension)", () => {
    // Plain Levenshtein would say distance 2; Damerau correctly says 1.
    expect(damerauLevenshtein("ca", "ac")).toBe(1);
    expect(damerauLevenshtein("tonkeeper", "tonkeepre")).toBe(1);
  });

  it("classic reference: kitten → sitting (substitute, substitute, insert) = 3", () => {
    expect(damerauLevenshtein("kitten", "sitting")).toBe(3);
  });

  it("is symmetric", () => {
    expect(damerauLevenshtein("alpha", "beta")).toBe(damerauLevenshtein("beta", "alpha"));
  });
});

// ── Jaro / Jaro–Winkler ───────────────────────────────────────────────────

describe("jaro / jaroWinkler", () => {
  it("returns 1 for identical strings", () => {
    expect(jaro("tonkeeper", "tonkeeper")).toBe(1);
    expect(jaroWinkler("tonkeeper", "tonkeeper")).toBe(1);
  });

  it("returns 0 when one string is empty", () => {
    expect(jaro("", "tonkeeper")).toBe(0);
    expect(jaroWinkler("", "tonkeeper")).toBe(0);
  });

  it("reproduces Winkler's classic 'MARTHA'/'MARHTA' example (≈0.961 with jaroWinkler)", () => {
    const result = jaroWinkler("MARTHA", "MARHTA");
    expect(result).toBeGreaterThan(0.96);
    expect(result).toBeLessThan(0.97);
  });

  it("reproduces 'DWAYNE'/'DUANE' example (≈0.84 with jaroWinkler)", () => {
    const result = jaroWinkler("DWAYNE", "DUANE");
    expect(result).toBeGreaterThan(0.83);
    expect(result).toBeLessThan(0.86);
  });

  it("boosts score for common-prefix matches via the Winkler step", () => {
    const jaroOnly = jaro("tonkeeper", "tonkeepers");
    const winkler = jaroWinkler("tonkeeper", "tonkeepers");
    // Winkler adds a prefix bonus when the shared prefix is long.
    expect(winkler).toBeGreaterThan(jaroOnly);
  });

  it("is symmetric (both jaro and jaroWinkler)", () => {
    expect(jaro("alpha", "alpine")).toBe(jaro("alpine", "alpha"));
    expect(jaroWinkler("alpha", "alpine")).toBe(jaroWinkler("alpine", "alpha"));
  });
});

// ── matchAgainstWatchlist ─────────────────────────────────────────────────

const fixtureWatchlist: readonly BrandWatchlistEntry[] = [
  {
    brand: "Tonkeeper",
    category: "wallet",
    matchKeys: ["tonkeeper", "tonkeeper_support", "tonkeeperofficial"],
    legitimateHandles: ["tonkeeper"],
  },
  {
    brand: "Binance",
    category: "exchange",
    matchKeys: ["binance", "binancesupport", "binance_official"],
    legitimateHandles: [],
  },
];

describe("matchAgainstWatchlist", () => {
  it("returns null when the candidate is empty", () => {
    expect(matchAgainstWatchlist("", fixtureWatchlist)).toBeNull();
  });

  it("returns 'exact' for a skeleton-identical match", () => {
    const result = matchAgainstWatchlist("Tonkeeper_Support", fixtureWatchlist);
    expect(result?.strength).toBe("exact");
    expect(result?.brand.brand).toBe("Tonkeeper");
    expect(result?.matchedKey).toBe("tonkeeper_support");
  });

  it("returns 'exact' for a Cyrillic-homoglyph match (after TR39 skeleton)", () => {
    // "Тоnkeeper" uses Cyrillic Т (U+0422) and о (U+043E).
    const result = matchAgainstWatchlist("Тоnkeeper", fixtureWatchlist);
    expect(result?.strength).toBe("exact");
    expect(result?.brand.brand).toBe("Tonkeeper");
  });

  it("returns 'near' for a Damerau-Levenshtein-1 match (single typo)", () => {
    const result = matchAgainstWatchlist("Tonkeepar", fixtureWatchlist);
    expect(result?.strength).toBe("near");
    expect(result?.brand.brand).toBe("Tonkeeper");
    expect(result?.distance).toBe(1);
  });

  it("returns 'near' for a transposition (Damerau distinguishes from Levenshtein)", () => {
    const result = matchAgainstWatchlist("Tonkeepre", fixtureWatchlist);
    expect(result?.strength).toBe("near");
    expect(result?.distance).toBe(1);
  });

  it("returns 'similar' for a deterministic distance-2 pair with strong prefix overlap", () => {
    // Construct a candidate that we PIN to DL=2 and JW≥0.92 via the
    // primitives first, then assert the matcher grades it as `similar`.
    // Without the explicit primitive pins, the grading depends on exact
    // distance arithmetic and the test could pass for the wrong reason.
    const matchKey = "tonkeeperofficial";
    const candidate = "tonkeeperoffizzal";

    expect(damerauLevenshtein(candidate, matchKey)).toBe(2);
    expect(jaroWinkler(candidate, matchKey)).toBeGreaterThanOrEqual(0.92);

    const result = matchAgainstWatchlist(candidate, fixtureWatchlist);
    expect(result?.strength).toBe("similar");
    expect(result?.distance).toBe(2);
    expect(result?.similarity).toBeGreaterThanOrEqual(0.92);
  });

  it("returns 'near' for a single-typo Binance match (direct grading verification)", () => {
    // "Binnance" is DL=1 (insertion of 'n') from "binance" — should
    // grade as `near`, not `similar`.
    const result = matchAgainstWatchlist("Binnance", fixtureWatchlist);
    expect(result?.strength).toBe("near");
    expect(result?.brand.brand).toBe("Binance");
  });

  it("returns null when distance is too large (no false-positives on unrelated names)", () => {
    expect(matchAgainstWatchlist("Wallet", fixtureWatchlist)).toBeNull();
    expect(matchAgainstWatchlist("EthereumProject", fixtureWatchlist)).toBeNull();
  });

  it("skips brands when candidateHandle is in their legitimateHandles list", () => {
    // `@tonkeeper` itself is the legitimate brand — should NOT match.
    const result = matchAgainstWatchlist("tonkeeper", fixtureWatchlist, {
      candidateHandle: "tonkeeper",
    });
    expect(result).toBeNull();
  });

  it("strips leading '@' from candidateHandle when checking legitimateHandles", () => {
    const result = matchAgainstWatchlist("tonkeeper", fixtureWatchlist, {
      candidateHandle: "@tonkeeper",
    });
    expect(result).toBeNull();
  });

  it("skips comparisons where length ratio > 2.0 (avoids tonkeeper vs ton false-positive)", () => {
    // "ton" (3 chars) vs "tonkeeper" (9 chars) ratio = 3.0, skip.
    const result = matchAgainstWatchlist("ton", fixtureWatchlist);
    expect(result).toBeNull();
  });

  it("returns the strongest match when multiple match keys would fire", () => {
    // Could match "tonkeeper" or "tonkeeper_support"; exact wins on the
    // longer one. We just assert one wins.
    const result = matchAgainstWatchlist("tonkeeperofficial", fixtureWatchlist);
    expect(result?.strength).toBe("exact");
    expect(result?.matchedKey).toBe("tonkeeperofficial");
  });

  it("matches documented seed impersonators that do not look like simple typos", () => {
    expect(matchAgainstWatchlist("FragmentOffersRoBot", seedWatchlist)).toMatchObject({
      brand: { brand: "Fragment" },
      strength: "exact",
    });
    expect(matchAgainstWatchlist("CBSupportchat", seedWatchlist)).toMatchObject({
      brand: { brand: "Coinbase" },
      strength: "exact",
    });
  });

  it("suppresses the official StarsHash bot and flags the Star Hash Robot clone shape", () => {
    expect(
      matchAgainstWatchlist("starshash_bot", seedWatchlist, { candidateHandle: "starshash_bot" }),
    ).toBeNull();
    expect(
      matchAgainstWatchlist("starhashrobot", seedWatchlist, { candidateHandle: "starhashrobot" }),
    ).toMatchObject({
      brand: { brand: "StarsHash" },
      strength: "exact",
    });
  });
});

describe("matchTextAgainstWatchlist", () => {
  it("matches brand lures embedded inside longer display/bio text", () => {
    const result = matchTextAgainstWatchlist(
      "Official Тоnkeeper support channel",
      fixtureWatchlist,
    );

    expect(result?.strength).toBe("exact");
    expect(result?.brand.brand).toBe("Tonkeeper");
    expect(result?.matchedKey).toBe("tonkeeper_support");
  });

  it("avoids generic single-token matches inside long text", () => {
    const walletWatchlist: readonly BrandWatchlistEntry[] = [
      {
        brand: "Wallet",
        category: "wallet",
        matchKeys: ["wallet"],
        legitimateHandles: ["wallet"],
      },
    ];

    expect(matchTextAgainstWatchlist("crypto wallet reviews", walletWatchlist)).toBeNull();
  });
});

describe("isFiringStrength", () => {
  // Read the first watchlist entry via array index access; fall back to
  // a local stub if (defensively) the fixture is empty. Avoids the
  // non-null assertion the linter rejects.
  const fakeBrand: BrandWatchlistEntry = fixtureWatchlist[0] ?? {
    brand: "Stub",
    category: "other",
    matchKeys: ["stub"],
    legitimateHandles: [],
  };

  const fakeMatch = (strength: "exact" | "near" | "similar" | "loose") =>
    ({
      strength,
      brand: fakeBrand,
      matchedKey: "tonkeeper",
      candidateSkeleton: "tonkeeper",
      distance: 0,
      similarity: 1,
    }) as const;

  it("returns true for exact, near, similar", () => {
    expect(isFiringStrength(fakeMatch("exact"))).toBe(true);
    expect(isFiringStrength(fakeMatch("near"))).toBe(true);
    expect(isFiringStrength(fakeMatch("similar"))).toBe(true);
  });

  it("returns false for loose (too noisy to fire alone)", () => {
    expect(isFiringStrength(fakeMatch("loose"))).toBe(false);
  });
});
