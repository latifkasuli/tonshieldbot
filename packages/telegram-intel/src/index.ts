export { isTelegramIntelEnabled, loadTelegramIntelConfig } from "./config.ts";
export type { TelegramIntelConfig } from "./config.ts";
export { createTelegramIntelClient } from "./client.ts";
export type { TelegramIntelClient } from "./client.ts";
export { classifyBotApiFailure } from "./failure.ts";
export type { BotApiFailure } from "./failure.ts";
export { parseTelegramUrl } from "./deeplink-parser.ts";
export type { ParsedTelegramUrl } from "./deeplink-parser.ts";
export {
  damerauLevenshtein,
  isFiringStrength,
  jaro,
  jaroWinkler,
  matchAgainstWatchlist,
  matchTextAgainstWatchlist,
  normalize,
} from "./handle-similarity.ts";
export type { BrandWatchlistEntry, MatchStrength, WatchlistMatch } from "./handle-similarity.ts";
export { loadSeedWatchlist, seedWatchlist } from "./watchlist.ts";
export {
  resolveChannelOrSupergroup,
  resolveById,
  resolveUserOrBot,
  resolvedEntityFromUser,
} from "./entity-resolver.ts";
export type { NotResolvableReason, ResolvedEntity, ResolverResult } from "./entity-resolver.ts";
