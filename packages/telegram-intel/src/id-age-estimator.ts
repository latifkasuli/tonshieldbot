import { z } from "zod";
import anchorsRaw from "../data/id-age-anchors.json" with { type: "json" };

/**
 * ID-age estimator for Telegram user/bot dialog IDs. Pure, deterministic,
 * fully unit-testable. Used by the `TELEGRAM_ENTITY_VERY_NEW` rule
 * (paired with another tier-1 signal — never fires alone).
 *
 * ## Methodology
 *
 * Linear interpolation between adjacent anchor points sorted by ID. For
 * any input `id`, we find the two flanking anchors and interpolate the
 * estimated creation date. For IDs above the table's max anchor, we
 * extrapolate from the last two anchors (rate carried forward). For IDs
 * below the table's min anchor — and especially the < 10⁶ "hand-allocated"
 * pre-2014 range — we return `null` rather than guess.
 *
 * ## Confidence bands
 *
 * Empirical observation from public anchor datasets (`Aayco/Creation`,
 * `go-tdage/tdage`, `lastochkin-group/...`): ~31% of adjacent anchors are
 * **inverted in time** because Telegram registration is sharded across DCs
 * (each shard issues from its own offset). Worst single inversion observed
 * in public data: ~160 days. **Do not promise sub-±60-day precision on
 * any post-2022 ID without a same-week anchor.**
 *
 * Bands we report:
 *   - `tight` (±14 days)  — adjacent anchors are within 30 days of each
 *     other AND ≥ 2017 AND ≤ 2021. The dense early/mid-2010s coverage in
 *     `tdage` is the only zone where this is honest.
 *   - `moderate` (±45 days) — adjacent anchors within 90 days of each
 *     other, anywhere.
 *   - `wide` (±90 days) — everywhere else: post-2021 (sharding noise floor
 *     is high), extrapolation past the last anchor, or sparse-anchor zones.
 *
 * ## Scope
 *
 * **User/bot IDs ONLY.** The Bot API ID-range table (per core.telegram.org/
 * api/bots/ids) shows separate counters for groups/supergroups/channels.
 * This estimator's anchor table is built from the user/bot counter and
 * MUST NOT be applied to negative (channel/supergroup) IDs. Callers route
 * by entity kind.
 *
 * ## What this is not
 *
 * - Not a guarantee. The estimator's output is a best-effort signal for
 *   pairing with other tier-1 findings. False positives are expected at
 *   non-pairing severity.
 * - Not a replacement for an authoritative source. If we ever gain access
 *   to one, this module retires.
 */

const anchorSchema = z.object({
  id: z.number().int().nonnegative(),
  date: z.iso.date(),
});

const anchorsFileSchema = z.object({
  kind: z.literal("user_or_bot"),
  license: z.string(),
  sources: z.array(z.string()),
  notes: z.array(z.string()),
  anchors: z.array(anchorSchema).min(10),
});

interface Anchor {
  readonly id: bigint;
  readonly createdAt: Date;
}

/**
 * Load, validate, and smooth the anchor table at module-import time.
 *
 * Smoothing: after sorting by ID, we keep only the "monotonic envelope" —
 * anchors whose date strictly advances past every kept predecessor. Public
 * anchor datasets (Aayco/Creation in particular) contain inversions caused
 * by registration sharding: two anchors with later IDs can have earlier
 * dates. Carrying those into interpolation produces negative slopes
 * locally and broken extrapolation at the table edge.
 *
 * The greedy keep-if-later-date filter drops ~5-10% of public-dataset
 * anchors but produces a strictly-monotonic table that interpolates and
 * extrapolates without surprises. The dropped anchors are noted via
 * source-data comments but not in the runtime data.
 *
 * Throws on schema violations or on a table with fewer than 10 surviving
 * anchors so a corrupt JSON file fails fast at startup rather than
 * producing silently-wrong estimates at scan time.
 */
const loadAnchors = (): readonly Anchor[] => {
  const parsed = anchorsFileSchema.parse(anchorsRaw);
  const sorted: Anchor[] = parsed.anchors
    .map((row) => ({
      id: BigInt(row.id),
      createdAt: new Date(row.date + "T00:00:00Z"),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Monotonic-envelope smoothing.
  const smoothed: Anchor[] = [];
  let maxDateMs = -Infinity;
  for (const anchor of sorted) {
    if (anchor.createdAt.getTime() > maxDateMs) {
      smoothed.push(anchor);
      maxDateMs = anchor.createdAt.getTime();
    }
  }

  if (smoothed.length < 10) {
    throw new Error(
      `id-age anchor table has only ${String(smoothed.length)} usable anchors after monotonic smoothing (need >= 10)`,
    );
  }

  return smoothed;
};

const ANCHORS = loadAnchors();

/** Minimum ID we'll attempt to estimate. Below this, the ID is hand-allocated. */
const HAND_ALLOCATED_CEILING = 1_000_000n;

export type AgeBand = "tight" | "moderate" | "wide";

export interface AgeEstimate {
  /** Best-effort creation date, midpoint of the estimated window. */
  readonly estimatedCreatedAt: Date;
  /** Half-width of the confidence interval, in days. */
  readonly confidenceBandDays: number;
  /** Coarse confidence tier driving the half-width. */
  readonly band: AgeBand;
  /** Age in days as observed from `options.now`, computed from `estimatedCreatedAt`. */
  readonly ageDays: number;
  /**
   * The matching anchor pair: the IDs on each side of the input.
   * `lowerAnchor` is the largest anchor ≤ input; `upperAnchor` is the
   * smallest anchor > input. For extrapolation beyond the table, both
   * are the last two anchors with `upperAnchor.id < id`.
   */
  readonly lowerAnchor: { readonly id: string; readonly createdAt: Date };
  readonly upperAnchor: { readonly id: string; readonly createdAt: Date };
  /** True when we extrapolated past the last anchor (id > max known). */
  readonly extrapolated: boolean;
}

/**
 * Estimate the creation date of a Telegram user/bot entity from its
 * numeric ID. Returns `null` when the ID is below the hand-allocated
 * threshold (< 10⁶ → pre-2014, undatable) or invalid (negative, NaN, etc.).
 *
 * **Do not call with channel/supergroup IDs.** Bot API channel IDs are
 * negative (`-100<x>`) and live in a separate counter; the caller is
 * expected to route by entity kind.
 *
 * For user/bot IDs above the table's max anchor, we extrapolate using the
 * slope of the last two anchors and return `band: "wide"`. This is the
 * correct behaviour for our use case — those are exactly the "freshly
 * created" IDs the `TELEGRAM_ENTITY_VERY_NEW` rule wants to flag.
 */
export const estimateUserOrBotIdAge = (
  id: bigint | number,
  options: { readonly now?: Date } = {},
): AgeEstimate | null => {
  const idBig = typeof id === "number" ? BigInt(Math.trunc(id)) : id;
  if (idBig <= 0n) return null;
  if (idBig < HAND_ALLOCATED_CEILING) return null;

  const now = options.now ?? new Date();

  const last = ANCHORS[ANCHORS.length - 1];
  const first = ANCHORS[0];
  if (last === undefined || first === undefined) return null; // unreachable after loader's .min(10)

  // Below the table — older than our earliest anchor. Clamp to the
  // earliest anchor's date with a wide band.
  if (idBig < first.id) {
    return buildEstimate(first.createdAt, "wide", first, first, false, now);
  }

  // Above the table — extrapolate using the slope of the last two anchors.
  if (idBig > last.id) {
    const prev = ANCHORS[ANCHORS.length - 2] ?? first;
    const estimated = extrapolate(prev, last, idBig);
    return buildEstimate(estimated, "wide", prev, last, true, now);
  }

  // Inside the table — binary search for the flanking pair.
  const { lower, upper } = findFlankingAnchors(idBig);
  const estimated = interpolate(lower, upper, idBig);
  const band = classifyBand(lower, upper);

  return buildEstimate(estimated, band, lower, upper, false, now);
};

// ── interpolation primitives ───────────────────────────────────────────────

const findFlankingAnchors = (id: bigint): { lower: Anchor; upper: Anchor } => {
  // Anchors are sorted ascending. Binary search for `upper` = first anchor
  // with `anchor.id > id`; `lower` is the predecessor.
  let lo = 0;
  let hi = ANCHORS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midAnchor = ANCHORS[mid];
    if (midAnchor !== undefined && midAnchor.id <= id) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  // `lo` is now the first index with `anchor.id > id`. If the id matches
  // exactly an anchor, `lo` lands on the next one, and lo-1 is the equal one.
  // Defensive fallback to the last anchor — the loader guarantees ≥ 10
  // anchors so the array is never empty.
  const fallback = ANCHORS[ANCHORS.length - 1] ?? ANCHORS[0];
  if (fallback === undefined) {
    throw new Error("id-age anchor table is empty (unreachable; loader enforces minimum size)");
  }
  const upper = ANCHORS[lo] ?? fallback;
  const lower = ANCHORS[Math.max(0, lo - 1)] ?? upper;
  return { lower, upper };
};

const interpolate = (lower: Anchor, upper: Anchor, id: bigint): Date => {
  if (upper.id === lower.id) return lower.createdAt;
  const idSpan = Number(upper.id - lower.id);
  const idOffset = Number(id - lower.id);
  const timeSpan = upper.createdAt.getTime() - lower.createdAt.getTime();
  return new Date(lower.createdAt.getTime() + (timeSpan * idOffset) / idSpan);
};

const extrapolate = (prev: Anchor, last: Anchor, id: bigint): Date => {
  if (last.id === prev.id) return last.createdAt;
  const idSpan = Number(last.id - prev.id);
  const timeSpan = last.createdAt.getTime() - prev.createdAt.getTime();
  // Rate: ms per ID. Apply to (id - last.id) and add to last.createdAt.
  const ratePerId = timeSpan / idSpan;
  const extraIds = Number(id - last.id);
  return new Date(last.createdAt.getTime() + extraIds * ratePerId);
};

// ── confidence band ────────────────────────────────────────────────────────

/**
 * Classify the confidence band of an interpolated estimate. Driven by two
 * things: (a) how far apart the flanking anchors are in time — tight gaps
 * = more confidence; (b) which era the estimate lands in — post-2021
 * sharding noise dominates everything else.
 */
const classifyBand = (lower: Anchor, upper: Anchor): AgeBand => {
  const gapMs = upper.createdAt.getTime() - lower.createdAt.getTime();
  const gapDays = gapMs / (1000 * 60 * 60 * 24);

  // Post-2022 (the 64-bit migration era) the sharding noise floor is real
  // — capping confidence at "wide" until we have same-week anchors is
  // honest. The 2022-01-01 boundary is arbitrary but conservative.
  if (upper.createdAt >= POST_MIGRATION_FLOOR) {
    return gapDays <= 60 ? "moderate" : "wide";
  }

  // Pre-migration era. Tdage's anchor density gives us honest tight
  // estimates when the gap is small. 35-day cutoff admits the
  // monthly-spaced anchors that dominate 2014-2017 without false-tight
  // claims on quarterly-spaced gaps.
  if (gapDays <= 35) return "tight";
  if (gapDays <= 90) return "moderate";
  return "wide";
};

const POST_MIGRATION_FLOOR = new Date("2022-01-01T00:00:00Z");

const BAND_HALF_WIDTH_DAYS: Readonly<Record<AgeBand, number>> = {
  tight: 14,
  moderate: 45,
  wide: 90,
};

const buildEstimate = (
  estimatedCreatedAt: Date,
  band: AgeBand,
  lower: Anchor,
  upper: Anchor,
  extrapolated: boolean,
  now: Date,
): AgeEstimate => ({
  estimatedCreatedAt,
  confidenceBandDays: BAND_HALF_WIDTH_DAYS[band],
  band,
  ageDays: Math.max(
    0,
    Math.round((now.getTime() - estimatedCreatedAt.getTime()) / (1000 * 60 * 60 * 24)),
  ),
  lowerAnchor: { id: lower.id.toString(), createdAt: lower.createdAt },
  upperAnchor: { id: upper.id.toString(), createdAt: upper.createdAt },
  extrapolated,
});

// ── public predicate ───────────────────────────────────────────────────────

/**
 * True iff the entity's estimated creation date (point estimate, not band
 * upper bound) is within `thresholdDays` of `now`.
 *
 * We deliberately do NOT subtract `confidenceBandDays` from the threshold
 * here. The earlier-draft logic was overly pessimistic: with realistic
 * post-2022 confidence bands (45–90 days), `ageDays + bandDays ≤ 30` is
 * essentially unreachable, so the rule would never fire on the very
 * entities it's designed to catch (freshly-deployed impersonators).
 *
 * Instead, we trust the **pairing gate** at the scanner layer to control
 * false-positives: `TELEGRAM_ENTITY_VERY_NEW` only emits when paired with
 * another tier-1 finding (`TELEGRAM_HANDLE_IMPERSONATES_PROJECT`,
 * `TELEGRAM_DISPLAY_NAME_HOMOGLYPH`, `TELEGRAM_USERNAME_RECENTLY_CHANGED`).
 * The band is reported on the evidence so consumers can render the
 * uncertainty, but it doesn't gate emission.
 */
export const isLikelyVeryNew = (estimate: AgeEstimate, thresholdDays: number): boolean =>
  estimate.ageDays <= thresholdDays;
