import { createFinding, getCoreRule } from "@tonshield/risk-engine";
import type { ActionPreview, RiskFinding } from "@tonshield/shared";
import {
  classifyBotApiFailure,
  estimateUserOrBotIdAge,
  isFiringStrength,
  isLikelyVeryNew,
  matchKnownRiskProjectHandle,
  matchAgainstWatchlist,
  matchTextAgainstWatchlist,
  resolveById,
  resolveChannelOrSupergroup,
  resolveUserOrBot,
  seedWatchlist,
  type AgeEstimate,
  type BrandWatchlistEntry,
  type KnownRiskProjectEntry,
  type NotResolvableReason,
  type ResolvedEntity,
  type ResolverResult,
  type TelegramIntelClient,
  type WatchlistMatch,
} from "@tonshield/telegram-intel";
import type { MtprotoIntelClient, MtprotoResolveResult } from "@tonshield/telegram-intel/mtproto";
import type { FragmentIntelClient, OwnershipCache } from "@tonshield/fragment-intel";
import type { GiftCatalogStore, TelegramEntityStore } from "@tonshield/storage";
import { checkFragmentHandoffForCandidates } from "./fragment-handoff.ts";
import { scanChatGiftsForUnknownPublisher } from "./gift-publisher-scanner.ts";

export interface TelegramScanResult {
  readonly findings: readonly RiskFinding[];
  readonly actions: readonly ActionPreview[];
}

const EMPTY_RESULT: TelegramScanResult = { findings: [], actions: [] };

/** Default cooldown between identical-content snapshots — 5 minutes per design §8 PR-2. */
const DEFAULT_SNAPSHOT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Inputs to `scanTelegramEntity` — kept small so the scanner is easy to
 * call from both the API request handler and the bot's update pipeline.
 *
 * Exactly one of `channelOrSupergroupHandle`, `userOrBotHandle`, or
 * `forwardOriginUser` MUST be set. The dispatching scanner (`basic-scan`)
 * threads the right field based on input classification.
 */
export interface ScanTelegramEntityInput {
  readonly channelOrSupergroupHandle?: string;
  readonly userOrBotHandle?: string;
  readonly numericId?: bigint;
  /**
   * `ResolvedEntity` derived from a forwarded message's
   * `forward_origin.sender_user`. Lets us snapshot bots/users we have
   * never `getChat`-resolved.
   */
  readonly forwardOriginUser?: ResolvedEntity;
  /**
   * Optional override of the impersonation watchlist. Defaults to the
   * curated seed bundled with `@tonshield/telegram-intel`. Tests inject
   * their own minimal lists; production wires the seed.
   */
  readonly watchlist?: readonly BrandWatchlistEntry[];
}

/**
 * Scans a Telegram entity and records a snapshot. PR-2 scope: degradation
 * findings + `TELEGRAM_USERNAME_RECENTLY_CHANGED`. Tier-1 impersonation
 * rules land in PR-3.
 *
 * Routing logic:
 *   1. If `forwardOriginUser` is set → snapshot directly, no Bot API call.
 *   2. If `numericId` is set → `resolveById`.
 *   3. If `channelOrSupergroupHandle` is set → `resolveChannelOrSupergroup`.
 *   4. If `userOrBotHandle` is set → `resolveUserOrBot` (always returns
 *      `not_resolvable` cold — fires `TELEGRAM_ENTITY_NOT_RESOLVABLE`).
 */
export const scanTelegramEntity = async (
  client: TelegramIntelClient | undefined,
  store: TelegramEntityStore,
  input: ScanTelegramEntityInput,
  options: {
    readonly now?: Date;
    readonly snapshotCooldownMs?: number;
    /**
     * When provided AND the entity resolves as a channel or supergroup,
     * the scanner opportunistically calls `getChatGifts` and emits
     * `TELEGRAM_GIFT_FROM_UNKNOWN_PUBLISHER` for owned gifts that fail
     * the catalog cross-reference. Silently degrades when the bot is not
     * a member of the chat (the common case for arbitrary scans).
     */
    readonly giftCatalog?: GiftCatalogStore;
    /**
     * Fragment intel client for on-chain username NFT lookups. When
     * provided, the scanner runs `checkFragmentHandoff` against the
     * pasted handle / resolved entity username and emits
     * `TELEGRAM_USERNAME_FRAGMENT_HANDOFF` on recent ownership
     * changes. `disabled` / failure outcomes degrade to info / low
     * health findings (mirroring the emulator pattern).
     */
    readonly fragment?: FragmentIntelClient;
    /**
     * Optional MTProto resolver for cold public username lookups. Bot API
     * remains the primary resolver; MTProto is only used after Bot API and
     * the local username cache cannot resolve the handle.
     */
    readonly mtproto?: MtprotoIntelClient;
    /**
     * Optional shared cache for Fragment ownership lookups. When set,
     * repeated lookups within a scan reuse the cached result instead
     * of re-issuing TONAPI calls. Apps wire this from a process-wide
     * `createOwnershipCache()`.
     */
    readonly fragmentCache?: OwnershipCache;
  } = {},
): Promise<TelegramScanResult> => {
  const now = options.now ?? new Date();
  const cooldownMs = options.snapshotCooldownMs ?? DEFAULT_SNAPSHOT_COOLDOWN_MS;
  const watchlist = input.watchlist ?? seedWatchlist;

  // Impersonation checks on the candidate handle run BEFORE resolution so
  // they fire even when Bot API can't be called or returns not-resolvable.
  // The user submitting `@tonkeeper_support` should see the impersonation
  // signal regardless of whether the handle resolves.
  const pastedHandle = input.channelOrSupergroupHandle ?? input.userOrBotHandle ?? null;
  const inputHandleFindings = checkCandidateHandle(pastedHandle, watchlist);
  const inputFakeBotFindings = checkSensitiveBotCategory(pastedHandle, null, watchlist);
  const inputKnownRiskFindings = checkKnownRiskProject(pastedHandle);

  // PR-36: Fragment on-chain ownership lookup. Per blocker on PR-36
  // review: the lookup must consider BOTH the pasted handle AND the
  // resolved/forwarded entity's canonical username — the user pastes
  // `@alias` but Fragment owns `@real`, OR a forwarded message carries
  // an entity.username we never had on the input side. Each branch
  // builds the candidate list it has access to and the multi-candidate
  // helper dedupes health findings (`FRAGMENT_API_NOT_CONFIGURED` /
  // `_UNAVAILABLE` emit at most once per scan).
  const runFragment = async (
    candidates: readonly (string | null | undefined)[],
  ): Promise<TelegramScanResult> => ({
    findings: await checkFragmentHandoffForCandidates(options.fragment, candidates, {
      ...(options.fragmentCache === undefined ? {} : { cache: options.fragmentCache }),
      ...(options.now === undefined ? {} : { now: () => options.now ?? new Date() }),
    }),
    actions: [],
  });

  // ── Forwarded-origin user/bot — no Bot API call needed ────────────────
  if (input.forwardOriginUser !== undefined) {
    const downstream = await snapshotAndDiff(
      store,
      input.forwardOriginUser,
      "forward",
      now,
      cooldownMs,
    );
    const impersonation = checkResolvedEntity(input.forwardOriginUser, watchlist);
    const fakeBot = checkSensitiveBotCategory(pastedHandle, input.forwardOriginUser, watchlist);
    // Forwarded path: pastedHandle is typically null (the user forwarded
    // a message rather than pasting a handle), but the forwardOriginUser
    // CAN carry a username. Feed both so the Fragment lookup runs even
    // for forward-only inputs.
    const fragmentScan = await runFragment([pastedHandle, input.forwardOriginUser.username]);
    const merged = mergeResults(
      inputHandleFindings,
      inputFakeBotFindings,
      inputKnownRiskFindings,
      fragmentScan,
      impersonation,
      fakeBot,
      checkKnownRiskProject(input.forwardOriginUser.username),
      downstream,
    );
    const ageFinding = checkEntityAge(input.forwardOriginUser, merged.findings, now);
    return ageFinding === null ? merged : mergeResults(merged, single(ageFinding));
  }

  if (client?.enabled !== true && options.mtproto?.enabled !== true) {
    return mergeResults(
      inputHandleFindings,
      inputFakeBotFindings,
      inputKnownRiskFindings,
      await runFragment([pastedHandle]),
      single(emulationFinding("TELEGRAM_BOT_API_NOT_CONFIGURED")),
    );
  }

  // ── Cold user/bot @handle path — MTProto can resolve when configured ─
  if (input.userOrBotHandle !== undefined) {
    const mtprotoResult = await resolveWithMtproto(options.mtproto, input.userOrBotHandle);
    if (mtprotoResult.status === "ok") {
      return await scanResolvedEntity({
        store,
        entity: mtprotoResult.entity,
        source: "mtproto",
        now,
        cooldownMs,
        watchlist,
        pastedHandle,
        inputHandleFindings,
        inputFakeBotFindings,
        inputKnownRiskFindings,
        fragmentScan: await runFragment([pastedHandle, mtprotoResult.entity.username]),
      });
    }

    const result = resolveUserOrBot(input.userOrBotHandle);
    return mergeResults(
      inputHandleFindings,
      inputFakeBotFindings,
      inputKnownRiskFindings,
      mtprotoResult.findings,
      await runFragment([pastedHandle]),
      mapNonOkResolverResult(result, "user_or_bot_handle_requires_prior_context"),
    );
  }

  let result: ResolverResult;

  if (input.numericId !== undefined) {
    result =
      client?.enabled === true
        ? await resolveById(client, input.numericId)
        : { status: "disabled" };
  } else if (input.channelOrSupergroupHandle !== undefined) {
    result =
      client?.enabled === true
        ? await resolveChannelOrSupergroup(client, input.channelOrSupergroupHandle)
        : { status: "disabled" };
    if (result.status === "not_resolvable" || result.status === "disabled") {
      const observedEntity =
        client?.enabled === true
          ? await store.findEntityByUsername(input.channelOrSupergroupHandle.replace(/^@/, ""))
          : null;
      if (observedEntity !== null) {
        const observedResult =
          client?.enabled === true
            ? await resolveById(client, observedEntity.id)
            : ({ status: "disabled" } as const);
        if (observedResult.status === "ok") {
          result = observedResult;
        }
      }
      if (result.status === "not_resolvable" || result.status === "disabled") {
        const mtprotoResult = await resolveWithMtproto(
          options.mtproto,
          input.channelOrSupergroupHandle,
        );
        if (mtprotoResult.status === "ok") {
          return await scanResolvedEntity({
            store,
            entity: mtprotoResult.entity,
            source: "mtproto",
            now,
            cooldownMs,
            watchlist,
            pastedHandle,
            inputHandleFindings,
            inputFakeBotFindings,
            inputKnownRiskFindings,
            fragmentScan: await runFragment([pastedHandle, mtprotoResult.entity.username]),
          });
        }
        if (mtprotoResult.findings.findings.length > 0) {
          return mergeResults(
            inputHandleFindings,
            inputFakeBotFindings,
            inputKnownRiskFindings,
            mtprotoResult.findings,
            await runFragment([pastedHandle]),
            mapNonOkResolverResult(result, "channel_or_supergroup_not_found"),
          );
        }
      }
    }
  } else {
    // No input fields populated — caller programming error, not a user
    // error. Treat as not-resolvable with a generic reason.
    return mergeResults(
      inputHandleFindings,
      inputFakeBotFindings,
      inputKnownRiskFindings,
      await runFragment([pastedHandle]),
      single(
        createFinding({
          confidence: "low",
          evidence: { reason: "no_resolvable_target_in_scan_input" },
          rule: getCoreRule("TELEGRAM_ENTITY_NOT_RESOLVABLE"),
        }),
      ),
    );
  }

  if (result.status === "ok") {
    const withAge = await scanResolvedEntity({
      store,
      entity: result.entity,
      source: "getChat",
      now,
      cooldownMs,
      watchlist,
      pastedHandle,
      inputHandleFindings,
      inputFakeBotFindings,
      inputKnownRiskFindings,
      fragmentScan: await runFragment([pastedHandle, result.entity.username]),
    });

    // M3 PR-8: opportunistic gift-publisher check for channels / supergroups
    // when the caller wired a catalog store. Degrades silently when
    // `getChatGifts` returns not_resolvable (bot not in chat — the common
    // case) so we don't pollute unrelated reports.
    // `client.enabled === true` is already guaranteed by the
    // short-circuit at the top of this function.
    const botApiClient = client?.enabled ? client : null;
    if (
      options.giftCatalog !== undefined &&
      botApiClient !== null &&
      (result.entity.kind === "channel" || result.entity.kind === "supergroup")
    ) {
      const giftFindings = await scanChatGiftsForUnknownPublisher(
        botApiClient,
        options.giftCatalog,
        result.entity.id,
      );
      if (giftFindings.findings.length > 0) {
        return mergeResults(withAge, { findings: giftFindings.findings, actions: [] });
      }
    }

    return withAge;
  }

  return mergeResults(
    inputHandleFindings,
    inputFakeBotFindings,
    inputKnownRiskFindings,
    await runFragment([pastedHandle]),
    mapNonOkResolverResult(
      result,
      input.channelOrSupergroupHandle !== undefined
        ? "channel_or_supergroup_not_found"
        : "user_or_bot_handle_requires_prior_context",
    ),
  );
};

const scanResolvedEntity = async (input: {
  readonly store: TelegramEntityStore;
  readonly entity: ResolvedEntity;
  readonly source: "getChat" | "mtproto";
  readonly now: Date;
  readonly cooldownMs: number;
  readonly watchlist: readonly BrandWatchlistEntry[];
  readonly pastedHandle: string | null;
  readonly inputHandleFindings: TelegramScanResult;
  readonly inputFakeBotFindings: TelegramScanResult;
  readonly inputKnownRiskFindings: TelegramScanResult;
  readonly fragmentScan: TelegramScanResult;
}): Promise<TelegramScanResult> => {
  const downstream = await snapshotAndDiff(
    input.store,
    input.entity,
    input.source,
    input.now,
    input.cooldownMs,
  );
  const impersonation = checkResolvedEntity(input.entity, input.watchlist);
  const fakeBot = checkSensitiveBotCategory(input.pastedHandle, input.entity, input.watchlist);
  const merged = mergeResults(
    input.inputHandleFindings,
    input.inputFakeBotFindings,
    input.inputKnownRiskFindings,
    input.fragmentScan,
    impersonation,
    fakeBot,
    checkKnownRiskProject(input.entity.username),
    downstream,
  );
  const ageFinding = checkEntityAge(input.entity, merged.findings, input.now);
  return ageFinding === null ? merged : mergeResults(merged, single(ageFinding));
};

const resolveWithMtproto = async (
  mtproto: MtprotoIntelClient | undefined,
  handle: string,
): Promise<
  | {
      readonly status: "ok";
      readonly entity: ResolvedEntity;
      readonly findings: TelegramScanResult;
    }
  | {
      readonly status: "not_ok";
      readonly result: MtprotoResolveResult;
      readonly findings: TelegramScanResult;
    }
> => {
  if (mtproto?.enabled !== true) {
    return { status: "not_ok", result: { status: "disabled" }, findings: EMPTY_RESULT };
  }

  const result = await mtproto.resolveUsername(handle);
  if (result.status === "ok") {
    return { status: "ok", entity: result.entity, findings: EMPTY_RESULT };
  }

  if (result.status === "rate_limited" || result.status === "failed") {
    return {
      status: "not_ok",
      result,
      findings: single(
        createFinding({
          confidence: "low",
          evidence:
            result.status === "rate_limited"
              ? {
                  reason: result.status,
                  retryAfter: result.retryAfter,
                  description: result.description,
                }
              : { reason: result.status, description: result.description },
          rule: getCoreRule("TELEGRAM_MTPROTO_LOOKUP_UNAVAILABLE"),
        }),
      ),
    };
  }

  return { status: "not_ok", result, findings: EMPTY_RESULT };
};

const snapshotAndDiff = async (
  store: TelegramEntityStore,
  entity: ResolvedEntity,
  source: "getChat" | "forward" | "mtproto",
  now: Date,
  cooldownMs: number,
): Promise<TelegramScanResult> => {
  const result = await store.recordSnapshot(
    {
      entityId: entity.id,
      entityKind: entity.kind,
      observedAt: now,
      username: entity.username,
      activeUsernames: entity.activeUsernames,
      displayName: entity.displayName,
      bio: entity.bio,
      photoFileUniqueId: entity.photoFileUniqueId,
      isPremium: entity.isPremium,
      memberCount: entity.memberCount,
      isBot: entity.isBot,
      source,
      raw: entity.raw,
    },
    { cooldownMs },
  );

  // No previous snapshot → first time we've seen this entity. Nothing to
  // diff against; return empty findings.
  if (result.previous === null) {
    return EMPTY_RESULT;
  }

  // Compare the just-observed username with the previous one. We use the
  // canonical `result.snapshot` (which equals `previous` if suppressed by
  // cooldown — in that case the diff is by definition null).
  const previousUsername = result.previous.username;
  const currentUsername = result.snapshot.username;

  if (
    previousUsername !== null &&
    currentUsername !== null &&
    previousUsername.toLowerCase() !== currentUsername.toLowerCase()
  ) {
    return single(
      createFinding({
        confidence: "high",
        evidence: {
          entityId: result.snapshot.entityId.toString(),
          previousUsername,
          currentUsername,
          previousObservedAt: result.previous.observedAt.toISOString(),
          currentObservedAt: result.snapshot.observedAt.toISOString(),
        },
        rule: getCoreRule("TELEGRAM_USERNAME_RECENTLY_CHANGED"),
      }),
    );
  }

  return EMPTY_RESULT;
};

const mapNonOkResolverResult = (
  result: ResolverResult,
  fallbackReason: NotResolvableReason,
): TelegramScanResult => {
  if (result.status === "disabled") {
    return single(emulationFinding("TELEGRAM_BOT_API_NOT_CONFIGURED"));
  }

  if (result.status === "not_resolvable") {
    return single(
      createFinding({
        confidence: "low",
        evidence: {
          reason: result.reason,
          description: result.description,
        },
        rule: getCoreRule("TELEGRAM_ENTITY_NOT_RESOLVABLE"),
      }),
    );
  }

  if (result.status === "failed") {
    return single(providerFailureFinding(result.failure));
  }

  // `result.status === "ok"` is handled in the caller; this branch is
  // defensive.
  return single(
    createFinding({
      confidence: "low",
      evidence: { reason: fallbackReason },
      rule: getCoreRule("TELEGRAM_ENTITY_NOT_RESOLVABLE"),
    }),
  );
};

// ── impersonation checks ───────────────────────────────────────────────────

/**
 * Run the watchlist matcher against a candidate handle (the user-submitted
 * `@somehandle` or the bot/channel target extracted from a URL). Runs
 * BEFORE Bot API resolution so the impersonation finding surfaces even
 * when resolution fails — `@tonkeeper_support` should flag whether or not
 * Bot API can resolve it.
 *
 * Returns an empty result when the candidate is `null` or no match meets
 * firing strength.
 */
const checkCandidateHandle = (
  candidate: string | null,
  watchlist: readonly BrandWatchlistEntry[],
): TelegramScanResult => {
  if (candidate === null) return EMPTY_RESULT;

  const cleaned = candidate.replace(/^@/, "");
  if (cleaned.length === 0) return EMPTY_RESULT;

  const match = matchAgainstWatchlist(cleaned, watchlist, { candidateHandle: cleaned });
  if (match === null || !isFiringStrength(match)) return EMPTY_RESULT;

  return single(
    createFinding({
      confidence: matchConfidence(match),
      evidence: {
        field: "handle",
        candidate: cleaned,
        candidateSkeleton: match.candidateSkeleton,
        matchedBrand: match.brand.brand,
        matchedBrandCategory: match.brand.category,
        matchedKey: match.matchedKey,
        strength: match.strength,
        distance: match.distance,
        similarity: Number(match.similarity.toFixed(4)),
      },
      rule: getCoreRule("TELEGRAM_HANDLE_IMPERSONATES_PROJECT"),
    }),
  );
};

/**
 * Run the watchlist matcher against the resolved entity's identifying
 * fields: `username`, `displayName`, and `bio`. The username check fires
 * `TELEGRAM_HANDLE_IMPERSONATES_PROJECT`; the displayName and bio checks
 * fire `TELEGRAM_DISPLAY_NAME_HOMOGLYPH` (display-name attacks live in
 * the Unicode-permitted fields, not the ASCII-only handle).
 *
 * Deduplication: a single entity can fire at most one
 * `TELEGRAM_HANDLE_IMPERSONATES_PROJECT` (from input handle OR resolved
 * username) and at most one `TELEGRAM_DISPLAY_NAME_HOMOGLYPH`
 * (preferring the strongest match across displayName/bio fields). The
 * scanner's merge step takes care of the cross-checks; this helper just
 * produces the candidates.
 */
const checkResolvedEntity = (
  entity: ResolvedEntity,
  watchlist: readonly BrandWatchlistEntry[],
): TelegramScanResult => {
  const findings: RiskFinding[] = [];

  // Resolved username → handle-impersonation rule.
  if (entity.username !== null && entity.username.length > 0) {
    const match = matchAgainstWatchlist(entity.username, watchlist, {
      candidateHandle: entity.username,
    });
    if (match !== null && isFiringStrength(match)) {
      findings.push(
        createFinding({
          confidence: matchConfidence(match),
          evidence: {
            field: "resolved_username",
            candidate: entity.username,
            candidateSkeleton: match.candidateSkeleton,
            matchedBrand: match.brand.brand,
            matchedBrandCategory: match.brand.category,
            matchedKey: match.matchedKey,
            strength: match.strength,
            distance: match.distance,
            similarity: Number(match.similarity.toFixed(4)),
          },
          rule: getCoreRule("TELEGRAM_HANDLE_IMPERSONATES_PROJECT"),
        }),
      );
    }
  }

  // Display name + bio → homoglyph rule. Pick the strongest match across
  // both fields so a single entity can produce at most one finding here.
  const displayCandidates: { field: string; value: string }[] = [];
  if (entity.displayName !== null && entity.displayName.length > 0) {
    displayCandidates.push({ field: "display_name", value: entity.displayName });
  }
  if (entity.bio !== null && entity.bio.length > 0) {
    displayCandidates.push({ field: "bio", value: entity.bio });
  }

  let bestDisplayMatch: { field: string; value: string; match: WatchlistMatch } | null = null;
  for (const candidate of displayCandidates) {
    // For displayName/bio we still pass the entity's username (when present)
    // as the candidateHandle, so a legitimate handle suppresses the match
    // even if the display name happens to be the brand verbatim.
    const candidateHandleArg =
      entity.username !== null && entity.username.length > 0 ? entity.username : undefined;
    const match = matchTextAgainstWatchlist(candidate.value, watchlist, {
      ...(candidateHandleArg === undefined ? {} : { candidateHandle: candidateHandleArg }),
    });
    if (match === null || !isFiringStrength(match)) continue;
    if (
      bestDisplayMatch === null ||
      matchStrengthRank(match) > matchStrengthRank(bestDisplayMatch.match)
    ) {
      bestDisplayMatch = { ...candidate, match };
    }
  }

  if (bestDisplayMatch !== null) {
    findings.push(
      createFinding({
        confidence: matchConfidence(bestDisplayMatch.match),
        evidence: {
          field: bestDisplayMatch.field,
          candidate: bestDisplayMatch.value,
          candidateSkeleton: bestDisplayMatch.match.candidateSkeleton,
          matchedBrand: bestDisplayMatch.match.brand.brand,
          matchedBrandCategory: bestDisplayMatch.match.brand.category,
          matchedKey: bestDisplayMatch.match.matchedKey,
          strength: bestDisplayMatch.match.strength,
          distance: bestDisplayMatch.match.distance,
          similarity: Number(bestDisplayMatch.match.similarity.toFixed(4)),
        },
        rule: getCoreRule("TELEGRAM_DISPLAY_NAME_HOMOGLYPH"),
      }),
    );
  }

  return { findings, actions: [] };
};

/**
 * PR-33: layered checks for fake wallet / validator bots. Fires
 * specialised rules on top of the generic `HANDLE_IMPERSONATES_PROJECT`
 * when the impersonated brand is in a high-risk category AND there's
 * positive bot signal — either the candidate handle ends in `bot`
 * (Telegram requires bot usernames to do so) or the resolved/forwarded
 * entity self-reports as a bot.
 *
 * Two candidate slots are inspected so the rule fires under either of
 * two realistic inputs:
 *   - User pastes the bot handle cold (Bot API can't resolve user/bot
 *     handles, but suffix + watchlist still gives us the signal).
 *   - A message forwarded from the bot resolves through Bot API and
 *     the entity is_bot is set; the handle may not itself end in `bot`.
 */
const checkSensitiveBotCategory = (
  pastedHandle: string | null,
  entity: ResolvedEntity | null,
  watchlist: readonly BrandWatchlistEntry[],
): TelegramScanResult => {
  const candidates: string[] = [];
  if (pastedHandle !== null) {
    const cleaned = pastedHandle.replace(/^@/, "");
    if (cleaned.length > 0) candidates.push(cleaned);
  }
  if (entity !== null && entity.username !== null && entity.username.length > 0) {
    if (!candidates.includes(entity.username)) {
      candidates.push(entity.username);
    }
  }
  if (candidates.length === 0) return EMPTY_RESULT;

  const entityIsBot = entity !== null && (entity.kind === "bot" || entity.isBot === true);

  for (const candidate of candidates) {
    const match = matchAgainstWatchlist(candidate, watchlist, { candidateHandle: candidate });
    if (match === null || !isFiringStrength(match)) continue;
    const category = match.brand.category;
    if (category !== "wallet" && category !== "validator") continue;

    const handleBotShape = /bot$/i.test(candidate);
    if (!handleBotShape && !entityIsBot) continue;

    const ruleId =
      category === "wallet" ? "TELEGRAM_FAKE_WALLET_BOT" : "TELEGRAM_FAKE_VALIDATOR_BOT";

    return single(
      createFinding({
        confidence: matchConfidence(match),
        evidence: {
          candidate,
          matchedBrand: match.brand.brand,
          matchedBrandCategory: category,
          matchedKey: match.matchedKey,
          strength: match.strength,
          similarity: Number(match.similarity.toFixed(4)),
          botIndicator: entityIsBot ? "entity_is_bot" : "handle_suffix",
        },
        rule: getCoreRule(ruleId),
      }),
    );
  }

  return EMPTY_RESULT;
};

const checkKnownRiskProject = (
  handle: string | null,
  registry?: readonly KnownRiskProjectEntry[],
): TelegramScanResult => {
  const match = matchKnownRiskProjectHandle(handle, registry);
  if (match === null) return EMPTY_RESULT;

  return single(
    createFinding({
      confidence: match.severity === "critical" ? "high" : "medium",
      evidence: {
        handle,
        project: match.project,
        risk: match.risk,
        registrySeverity: match.severity,
        notes: match.notes ?? null,
      },
      rule: getCoreRule("TELEGRAM_KNOWN_RISK_PROJECT"),
    }),
  );
};

const matchStrengthRank = (match: WatchlistMatch): number => {
  switch (match.strength) {
    case "exact":
      return 4;
    case "near":
      return 3;
    case "similar":
      return 2;
    case "loose":
      return 1;
  }
};

const matchConfidence = (match: WatchlistMatch): "low" | "medium" | "high" => {
  switch (match.strength) {
    case "exact":
      return "high";
    case "near":
      return "high";
    case "similar":
      return "medium";
    case "loose":
      return "low";
  }
};

/**
 * Concatenate multiple `TelegramScanResult`s into one. When two results
 * fire the SAME ruleId, keep only the highest-confidence finding —
 * deduplicates the case where the input handle and the resolved username
 * both flag the same impersonation.
 */
const mergeResults = (...results: readonly TelegramScanResult[]): TelegramScanResult => {
  const findingsByKey = new Map<string, RiskFinding>();
  const actions: ActionPreview[] = [];

  for (const result of results) {
    for (const finding of result.findings) {
      const existing = findingsByKey.get(finding.ruleId);
      if (
        existing === undefined ||
        confidenceRank(finding.confidence) > confidenceRank(existing.confidence)
      ) {
        findingsByKey.set(finding.ruleId, finding);
      }
    }
    actions.push(...result.actions);
  }

  return { findings: Array.from(findingsByKey.values()), actions };
};

const confidenceRank = (confidence: "low" | "medium" | "high"): number => {
  switch (confidence) {
    case "low":
      return 0;
    case "medium":
      return 1;
    case "high":
      return 2;
  }
};

// ── ID age check (PR-4) ────────────────────────────────────────────────────

/**
 * Set of rule IDs that count as a "tier-1 paired signal" for the
 * `TELEGRAM_ENTITY_VERY_NEW` rule. The age rule never fires alone — only
 * when at least one of these is also present on the report. Keeping the
 * list explicit here (rather than e.g. checking severity ≥ medium) means
 * adding a new tier-1 rule is a deliberate decision, not an accident of
 * severity grading.
 */
const TIER_1_PAIR_RULES: ReadonlySet<string> = new Set([
  "TELEGRAM_HANDLE_IMPERSONATES_PROJECT",
  "TELEGRAM_DISPLAY_NAME_HOMOGLYPH",
  "TELEGRAM_USERNAME_RECENTLY_CHANGED",
]);

const VERY_NEW_THRESHOLD_DAYS = 30;

/**
 * Estimate the entity's age from its numeric ID and emit
 * `TELEGRAM_ENTITY_VERY_NEW` IFF:
 *
 *   1. The entity kind is user or bot (channel/supergroup uses a separate
 *      ID counter; PR-4 ships user/bot only).
 *   2. The point-estimated age is ≤ 30 days.
 *   3. At least one tier-1 paired finding is already present in
 *      `accumulatedFindings`.
 *
 * The pairing requirement is the load-bearing false-positive control:
 * legitimate new projects DO launch on Telegram every day, and the ID-age
 * estimator's noise floor is real. The combined signal (newness + brand
 * impersonation OR username churn) is much higher-confidence than either
 * alone.
 *
 * Returns `null` when any of the gates fail — never produces a noisy
 * standalone finding.
 */
const checkEntityAge = (
  entity: ResolvedEntity,
  accumulatedFindings: readonly RiskFinding[],
  now: Date,
): RiskFinding | null => {
  if (entity.kind !== "user" && entity.kind !== "bot") return null;

  const hasPairedSignal = accumulatedFindings.some((f) => TIER_1_PAIR_RULES.has(f.ruleId));
  if (!hasPairedSignal) return null;

  const estimate = estimateUserOrBotIdAge(entity.id, { now });
  if (estimate === null) return null;
  if (!isLikelyVeryNew(estimate, VERY_NEW_THRESHOLD_DAYS)) return null;

  return createFinding({
    confidence: ageConfidence(estimate),
    evidence: ageEvidence(entity, estimate, accumulatedFindings),
    rule: getCoreRule("TELEGRAM_ENTITY_VERY_NEW"),
  });
};

const ageConfidence = (estimate: AgeEstimate): "low" | "medium" | "high" => {
  switch (estimate.band) {
    case "tight":
      return "high";
    case "moderate":
      return "medium";
    case "wide":
      return "low";
  }
};

const ageEvidence = (
  entity: ResolvedEntity,
  estimate: AgeEstimate,
  accumulatedFindings: readonly RiskFinding[],
): Readonly<Record<string, unknown>> => ({
  entityId: entity.id.toString(),
  entityKind: entity.kind,
  estimatedCreatedAt: estimate.estimatedCreatedAt.toISOString(),
  ageDays: estimate.ageDays,
  confidenceBandDays: estimate.confidenceBandDays,
  band: estimate.band,
  extrapolated: estimate.extrapolated,
  pairedRuleIds: accumulatedFindings.map((f) => f.ruleId).filter((id) => TIER_1_PAIR_RULES.has(id)),
});

// ── helpers ─────────────────────────────────────────────────────────────────

const single = (finding: RiskFinding): TelegramScanResult => ({
  findings: [finding],
  actions: [],
});

const emulationFinding = (
  ruleId:
    | "TELEGRAM_BOT_API_NOT_CONFIGURED"
    | "TELEGRAM_BOT_API_RATE_LIMITED"
    | "TELEGRAM_BOT_API_PROVIDER_DOWN"
    | "TELEGRAM_BOT_API_FAILED"
    | "TELEGRAM_ENTITY_NOT_RESOLVABLE",
  evidence: Readonly<Record<string, unknown>> = {},
): RiskFinding =>
  createFinding({
    confidence: "low",
    evidence,
    rule: getCoreRule(ruleId),
  });

const providerFailureFinding = (failure: ReturnType<typeof classifyBotApiFailure>): RiskFinding => {
  // Mirror of the PR-D1 emulator-side classifier shape.
  const ruleId =
    failure.status === "rate_limited"
      ? "TELEGRAM_BOT_API_RATE_LIMITED"
      : failure.status === "provider_down"
        ? "TELEGRAM_BOT_API_PROVIDER_DOWN"
        : failure.status === "failed"
          ? "TELEGRAM_BOT_API_FAILED"
          : "TELEGRAM_ENTITY_NOT_RESOLVABLE";

  return emulationFinding(ruleId, {
    source: "bot_api_call",
    ...(failure.status === "rate_limited"
      ? { httpStatus: 429, retryAfter: failure.retryAfter }
      : failure.status === "provider_down"
        ? { httpStatus: failure.httpStatus }
        : failure.status === "failed"
          ? { httpStatus: failure.httpStatus, description: failure.description }
          : { description: failure.description }),
  });
};
