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
export { estimateUserOrBotIdAge, isLikelyVeryNew } from "./id-age-estimator.ts";
export type { AgeBand, AgeEstimate } from "./id-age-estimator.ts";
export { analyseMiniAppContent } from "./miniapp-content.ts";
export type {
  ApkLink,
  KeywordMatch,
  KeywordSeverity,
  MiniAppContentReport,
  TonAddress,
} from "./miniapp-content.ts";
export { parseGiftPage } from "./gift-link-resolver.ts";
export type {
  GiftLinkNotVerifiedReason,
  GiftLinkResolution,
  GiftMetadata,
} from "./gift-link-resolver.ts";
export { DEFAULT_CHAT_GIFTS_CAP, fetchAvailableGifts, fetchChatGifts } from "./gift-catalog.ts";
export type {
  AvailableGiftsResult,
  ChatGiftsResult,
  NormalisedCatalogGift,
  NormalisedOwnedGift,
} from "./gift-catalog.ts";
export {
  DANGEROUS_RIGHTS,
  includesDangerousRight,
  parseBusinessRights,
} from "./business-rights-parser.ts";
export type { BusinessRight, BusinessRightsParseResult } from "./business-rights-parser.ts";
export {
  knownRiskProjects,
  loadKnownRiskProjects,
  matchKnownRiskProjectHandle,
} from "./project-risk-registry.ts";
export type { KnownRiskProjectEntry } from "./project-risk-registry.ts";
