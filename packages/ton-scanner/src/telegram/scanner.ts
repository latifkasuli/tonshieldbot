import { createFinding, getCoreRule } from "@tonshield/risk-engine";
import type { ActionPreview, RiskFinding } from "@tonshield/shared";
import {
  classifyBotApiFailure,
  resolveById,
  resolveChannelOrSupergroup,
  resolveUserOrBot,
  type NotResolvableReason,
  type ResolvedEntity,
  type ResolverResult,
  type TelegramIntelClient,
} from "@tonshield/telegram-intel";
import type { TelegramEntityStore } from "@tonshield/storage";

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
  options: { readonly now?: Date; readonly snapshotCooldownMs?: number } = {},
): Promise<TelegramScanResult> => {
  const now = options.now ?? new Date();
  const cooldownMs = options.snapshotCooldownMs ?? DEFAULT_SNAPSHOT_COOLDOWN_MS;

  // ── Forwarded-origin user/bot — no Bot API call needed ────────────────
  if (input.forwardOriginUser !== undefined) {
    return await snapshotAndDiff(store, input.forwardOriginUser, "forward", now, cooldownMs);
  }

  if (client?.enabled !== true) {
    return single(emulationFinding("TELEGRAM_BOT_API_NOT_CONFIGURED"));
  }

  // ── Cold user/bot @handle path — always not-resolvable ───────────────
  if (input.userOrBotHandle !== undefined) {
    const result = resolveUserOrBot(input.userOrBotHandle);
    return mapNonOkResolverResult(result, "user_or_bot_handle_requires_prior_context");
  }

  let result: ResolverResult;

  if (input.numericId !== undefined) {
    result = await resolveById(client, input.numericId);
  } else if (input.channelOrSupergroupHandle !== undefined) {
    result = await resolveChannelOrSupergroup(client, input.channelOrSupergroupHandle);
  } else {
    // No input fields populated — caller programming error, not a user
    // error. Treat as not-resolvable with a generic reason.
    return single(
      createFinding({
        confidence: "low",
        evidence: { reason: "no_resolvable_target_in_scan_input" },
        rule: getCoreRule("TELEGRAM_ENTITY_NOT_RESOLVABLE"),
      }),
    );
  }

  if (result.status === "ok") {
    return await snapshotAndDiff(store, result.entity, "getChat", now, cooldownMs);
  }

  return mapNonOkResolverResult(
    result,
    input.channelOrSupergroupHandle !== undefined
      ? "channel_or_supergroup_not_found"
      : "user_or_bot_handle_requires_prior_context",
  );
};

const snapshotAndDiff = async (
  store: TelegramEntityStore,
  entity: ResolvedEntity,
  source: "getChat" | "forward",
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
