import { z } from "zod";
import type { BrandWatchlistEntry } from "./handle-similarity.ts";
// Inline import the JSON so it's bundled with the package and we don't
// rely on `import.meta.resolve` or filesystem reads at runtime. The seed
// file is checked into the repo at packages/telegram-intel/data/.
import seedRaw from "../data/watchlist-seed.json" with { type: "json" };

/**
 * Curated allow-list-style watchlist of high-value brand identities the
 * TON-Shield scanner should detect impersonation of. Source per
 * docs/research/m3-design.md §6 — seeded from top-N most-impersonated
 * entities in 2024-2026 research.
 *
 * Two-tier storage was designed (JSON seed + DB override; see §9 Q3 of the
 * design doc), but PR-3 ships only the JSON seed. DB-override lands in a
 * later micro-PR if hot-patching scam handles without redeploys proves
 * operationally important.
 *
 * Validation happens at load time via zod so a malformed seed file fails
 * fast at startup rather than producing silently-wrong matches at scan
 * time. The schema is intentionally permissive on `notes` (free-form text)
 * and strict on the fields the matcher consumes.
 */

const entrySchema = z.object({
  brand: z.string().min(1),
  category: z.enum(["wallet", "exchange", "mini_app_platform", "infra", "marketplace", "other"]),
  matchKeys: z.array(z.string().min(1)).min(1),
  legitimateHandles: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

const watchlistSchema = z.array(entrySchema).min(1);

/**
 * Load and validate the seed watchlist. Throws on schema violations — the
 * caller (usually `createTelegramIntelClient` or a startup hook) should
 * let the error propagate so a malformed seed crashes the service rather
 * than silently disabling impersonation detection.
 */
export const loadSeedWatchlist = (): readonly BrandWatchlistEntry[] => {
  const parsed = watchlistSchema.parse(seedRaw);
  // The zod schema's output matches `BrandWatchlistEntry` structurally;
  // the cast is purely a TS shape-narrowing for the consumer.
  return parsed as readonly BrandWatchlistEntry[];
};

/**
 * The seed watchlist eagerly loaded at module import. Exported as a
 * `readonly` array so consumers can pass it directly to
 * `matchAgainstWatchlist` without re-validating per scan.
 */
export const seedWatchlist: readonly BrandWatchlistEntry[] = loadSeedWatchlist();
