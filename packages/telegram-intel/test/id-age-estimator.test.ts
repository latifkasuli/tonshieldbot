import { describe, expect, it } from "vitest";
import { estimateUserOrBotIdAge, isLikelyVeryNew } from "../src/id-age-estimator.ts";

// All `now` dates in these tests are deterministic — the estimator
// produces stable output for a given (id, now) pair regardless of
// wall-clock time.
const NOW = new Date("2026-05-11T00:00:00Z");

describe("estimateUserOrBotIdAge — invalid / out-of-range inputs", () => {
  it("returns null for zero and negative IDs", () => {
    expect(estimateUserOrBotIdAge(0, { now: NOW })).toBeNull();
    expect(estimateUserOrBotIdAge(-1, { now: NOW })).toBeNull();
    expect(estimateUserOrBotIdAge(-1_000_000_000_000n, { now: NOW })).toBeNull();
  });

  it("returns null for non-finite numeric inputs", () => {
    expect(estimateUserOrBotIdAge(Number.NaN, { now: NOW })).toBeNull();
    expect(estimateUserOrBotIdAge(Number.POSITIVE_INFINITY, { now: NOW })).toBeNull();
    expect(estimateUserOrBotIdAge(Number.NEGATIVE_INFINITY, { now: NOW })).toBeNull();
  });

  it("returns null for hand-allocated pre-2014 IDs (< 1_000_000)", () => {
    // Aayco/Creation README: 'Older IDs (e.g. short ones like 25) are not
    // timestamp-based.' We return null rather than guess.
    expect(estimateUserOrBotIdAge(25, { now: NOW })).toBeNull();
    expect(estimateUserOrBotIdAge(500_000, { now: NOW })).toBeNull();
    // Exactly at the threshold: still excluded.
    expect(estimateUserOrBotIdAge(999_999, { now: NOW })).toBeNull();
  });

  it("accepts the threshold ID exactly (1_000_000) — first anchor", () => {
    const result = estimateUserOrBotIdAge(1_000_000n, { now: NOW });
    expect(result).not.toBeNull();
    // First anchor is 2013-09-28; should land on that date.
    expect(result?.estimatedCreatedAt.toISOString().slice(0, 10)).toBe("2013-09-28");
  });

  it("accepts bigint and number inputs equivalently", () => {
    const a = estimateUserOrBotIdAge(5_500_000_000n, { now: NOW });
    const b = estimateUserOrBotIdAge(5_500_000_000, { now: NOW });
    expect(a?.estimatedCreatedAt.toISOString()).toBe(b?.estimatedCreatedAt.toISOString());
  });
});

describe("estimateUserOrBotIdAge — interpolation", () => {
  it("interpolates between two adjacent pre-migration anchors", () => {
    // Halfway between 2014-04-12 (id 11_538_514) and 2014-05-01 (id
    // 26_016_150) → approximately 2014-04-21.
    const midId = (11_538_514n + 26_016_150n) / 2n;
    const result = estimateUserOrBotIdAge(midId, { now: NOW });
    expect(result).not.toBeNull();
    const month = result?.estimatedCreatedAt.toISOString().slice(0, 7);
    expect(month).toBe("2014-04");
  });

  it("returns the exact anchor date when the input ID is an anchor", () => {
    // Anchor: 925_396_585 → 2019-08-26
    const result = estimateUserOrBotIdAge(925_396_585n, { now: NOW });
    expect(result?.estimatedCreatedAt.toISOString().slice(0, 10)).toBe("2019-08-26");
  });

  it("returns flanking anchors in the result", () => {
    // Pick an ID strictly between two known anchors.
    const result = estimateUserOrBotIdAge(150_000_000n, { now: NOW });
    expect(result).not.toBeNull();
    // 148_483_597 (2016-01-01) and 152_888_896 (2016-02-01) flank it.
    expect(result?.lowerAnchor.id).toBe("148483597");
    expect(result?.upperAnchor.id).toBe("152888896");
    expect(result?.extrapolated).toBe(false);
  });
});

describe("estimateUserOrBotIdAge — extrapolation past the table edge", () => {
  it("extrapolates a date past the last anchor for very-new IDs", () => {
    // Anchor table currently ends near id ~8.78B (2026-05-10). Pick an
    // ID solidly past that to exercise the extrapolation path.
    const result = estimateUserOrBotIdAge(10_000_000_000n, { now: NOW });
    expect(result).not.toBeNull();
    expect(result?.extrapolated).toBe(true);
    expect(result?.band).toBe("wide");
  });

  it("ageDays is small (≤ year) for an ID just past the leading edge", () => {
    // Extrapolating a few hundred million past the last anchor should
    // produce an age in days that's small relative to a year, OR clamp
    // to zero if the extrapolated date is in the future.
    const result = estimateUserOrBotIdAge(9_500_000_000n, { now: NOW });
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(result.ageDays).toBeGreaterThanOrEqual(0);
      expect(result.ageDays).toBeLessThan(730);
    }
  });
});

describe("estimateUserOrBotIdAge — confidence bands", () => {
  it("returns 'tight' (±14d) for densely-anchored pre-migration mid-2010s IDs", () => {
    // Several adjacent anchors in 2016 are spaced ~30 days. Pick an ID
    // between two adjacent monthly anchors. Tight threshold admits gaps
    // ≤ 35 days, so a monthly-spaced pair qualifies.
    const result = estimateUserOrBotIdAge(150_000_000n, { now: NOW });
    expect(result?.band).toBe("tight");
    expect(result?.confidenceBandDays).toBe(14);
  });

  it("returns at most 'moderate' for post-2022 IDs even if anchors are close", () => {
    // 5.5B is post-migration. Even though some 2022 anchors are
    // ~3 months apart, sharding noise prohibits 'tight'.
    const result = estimateUserOrBotIdAge(5_500_000_000n, { now: NOW });
    expect(result?.band).not.toBe("tight");
  });

  it("returns 'wide' for extrapolated estimates", () => {
    const result = estimateUserOrBotIdAge(9_500_000_000n, { now: NOW });
    expect(result?.band).toBe("wide");
    expect(result?.confidenceBandDays).toBe(90);
  });
});

describe("estimateUserOrBotIdAge — ageDays computation", () => {
  it("computes ageDays relative to `options.now`", () => {
    // Pick a known anchor and check the day count to NOW.
    // 925_396_585 → 2019-08-26. NOW is 2026-05-11. ≈ 2451 days.
    const result = estimateUserOrBotIdAge(925_396_585n, { now: NOW });
    expect(result?.ageDays).toBeGreaterThan(2400);
    expect(result?.ageDays).toBeLessThan(2500);
  });

  it("clamps ageDays at 0 when the estimate would be in the future", () => {
    // Extrapolate hard past the leading edge of the table. Should never
    // yield a negative ageDays — we floor at zero.
    const result = estimateUserOrBotIdAge(100_000_000_000n, { now: NOW });
    expect(result?.ageDays).toBeGreaterThanOrEqual(0);
  });
});

describe("isLikelyVeryNew — point-estimate predicate", () => {
  const fake = (ageDays: number, band: 14 | 45 | 90) =>
    ({
      estimatedCreatedAt: new Date(),
      ageDays,
      confidenceBandDays: band,
      band: band === 14 ? "tight" : band === 45 ? "moderate" : ("wide" as const),
      lowerAnchor: { id: "0", createdAt: new Date() },
      upperAnchor: { id: "0", createdAt: new Date() },
      extrapolated: false,
    }) as const;

  it("returns true when point estimate is within threshold, regardless of band", () => {
    expect(isLikelyVeryNew(fake(5, 14), 30)).toBe(true);
    expect(isLikelyVeryNew(fake(15, 45), 30)).toBe(true);
    expect(isLikelyVeryNew(fake(0, 90), 30)).toBe(true);
    expect(isLikelyVeryNew(fake(30, 90), 30)).toBe(true);
  });

  it("returns false when point estimate exceeds threshold", () => {
    expect(isLikelyVeryNew(fake(31, 14), 30)).toBe(false);
    expect(isLikelyVeryNew(fake(60, 45), 30)).toBe(false);
    expect(isLikelyVeryNew(fake(365, 90), 30)).toBe(false);
  });
});

describe("estimateUserOrBotIdAge — anchor table sanity", () => {
  it("returns the same estimate when called twice with the same input (deterministic)", () => {
    const a = estimateUserOrBotIdAge(5_500_000_000n, { now: NOW });
    const b = estimateUserOrBotIdAge(5_500_000_000n, { now: NOW });
    expect(a).toEqual(b);
  });

  it("produces monotonically advancing estimates as ID grows (anchored region)", () => {
    // We don't promise STRICT monotonicity (sharding inversions in the
    // anchor data itself can produce localized backwards motion), but
    // across well-separated IDs the trend MUST advance.
    const a = estimateUserOrBotIdAge(150_000_000n, { now: NOW });
    const b = estimateUserOrBotIdAge(1_000_000_000n, { now: NOW });
    const c = estimateUserOrBotIdAge(5_500_000_000n, { now: NOW });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    if (a && b && c) {
      expect(a.estimatedCreatedAt.getTime()).toBeLessThan(b.estimatedCreatedAt.getTime());
      expect(b.estimatedCreatedAt.getTime()).toBeLessThan(c.estimatedCreatedAt.getTime());
    }
  });
});
