import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { createApiKeyAuth } from "@tonshield/api-auth";
import type { AuthVariables } from "@tonshield/api-auth";
import { createHonoLogger } from "@tonshield/logger";
import type { Logger, LoggerVariables } from "@tonshield/logger";
import { createHonoRateLimit, defaultTierLimits } from "@tonshield/rate-limit";
import type { RateLimiter } from "@tonshield/rate-limit";
import { TtlFetchCache } from "@tonshield/safe-fetch";
import type { FragmentIntelClient, OwnershipCache } from "@tonshield/fragment-intel";
import {
  canonicalInputHash,
  type ApiKeyStore,
  type GiftCatalogStore,
  type ReportStore,
  type TelegramEntityStore,
} from "@tonshield/storage";
import type { TelegramIntelClient } from "@tonshield/telegram-intel";
import type { MtprotoIntelClient } from "@tonshield/telegram-intel/mtproto";
import type { TonEmulatorClient } from "@tonshield/ton-emulator";
import { classifyInput, createBasicScan, isScanResultCacheable } from "@tonshield/ton-scanner";

const scanRequestSchema = z.object({
  input: z.string().min(1),
});

type ServerVariables = AuthVariables & LoggerVariables;
type ServerContext = Context<{ Variables: ServerVariables }>;
// Hono's middleware hooks (auth's `onAuth*`, rate-limit's `identify`) expose
// a generic `Context` that doesn't carry the app's Variables. We narrow at
// the hook boundary so downstream access stays typed without leaking the
// cast into application logic.
const asServerContext = (c: Context): ServerContext => c as ServerContext;

export interface CreateApiServerOptions {
  readonly logger: Logger;
  readonly apiKeys: ApiKeyStore;
  readonly reports: ReportStore;
  readonly rateLimiter: RateLimiter;
  /**
   * TONAPI client for M2 emulation. The scanner branches on `client.enabled`
   * internally, so we always pass it through; an unconfigured deployment
   * still surfaces `EMULATION_NOT_CONFIGURED` so the omission is visible.
   */
  readonly emulator: TonEmulatorClient;
  /**
   * Telegram Bot API client for M3 intelligence. Same fail-soft posture as
   * the emulator: passed through unconditionally; `client.enabled === false`
   * surfaces `TELEGRAM_BOT_API_NOT_CONFIGURED` to the user.
   */
  readonly telegramIntel: TelegramIntelClient;
  /** Optional MTProto fallback for cold public username resolution. */
  readonly mtprotoIntel: MtprotoIntelClient;
  /** Telegram entity snapshot store. From `storage.telegramEntities`. */
  readonly telegramEntities: TelegramEntityStore;
  /**
   * Telegram gift catalog cache. From `storage.telegramGiftCatalog`.
   * Enables `TELEGRAM_GIFT_FROM_UNKNOWN_PUBLISHER` when scanning
   * channels the bot can access. Population is driven by the worker's
   * periodic `refreshGiftCatalog` job.
   */
  readonly telegramGiftCatalog: GiftCatalogStore;
  /**
   * Fragment intel client (PR-36) — on-chain username NFT lookups.
   * Same fail-soft posture as the emulator: passed through
   * unconditionally; `client.enabled === false` surfaces
   * `FRAGMENT_API_NOT_CONFIGURED`.
   */
  readonly fragment: FragmentIntelClient;
  /** Process-wide TTL cache for Fragment lookups. */
  readonly fragmentCache: OwnershipCache;
}

/**
 * Composes the api Hono app:
 *   - Logger middleware on every route (request id propagation, timing)
 *   - Auth + rate limit on `/v1/*` only (health stays public and unmetered)
 *   - Scan handler does cache lookup → fall through to scan → persist,
 *     so two requests with the same canonical input hit the work once.
 */
export const createApiServer = (
  options: CreateApiServerOptions,
): Hono<{ Variables: ServerVariables }> => {
  const app = new Hono<{ Variables: ServerVariables }>();
  const manifestCache = new TtlFetchCache();

  app.use("*", createHonoLogger({ logger: options.logger }));

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "tonshield-api",
    }),
  );

  app.use(
    "/v1/*",
    createApiKeyAuth({
      apiKeys: options.apiKeys,
      onAuthFailure: (reason, c) => {
        asServerContext(c).var.log.warn({ reason }, "auth_failed");
      },
      onAuthSuccess: (resolved, c) => {
        const typed = asServerContext(c);
        // Bind tenant info to the per-request logger so every downstream
        // log line in this request carries it.
        const log = typed.var.log.child({
          tenant_id: resolved.tenantId,
          api_key_id: resolved.id,
        });
        typed.set("log", log);
      },
    }),
  );

  app.use(
    "/v1/*",
    createHonoRateLimit({
      limiter: options.rateLimiter,
      tiers: defaultTierLimits,
      // The auth middleware mounted before this one always populates
      // c.var.apiKey on a successful path (failures short-circuit with 401),
      // so we read it unconditionally here.
      identify: (c) => asServerContext(c).var.apiKey.tenantId,
      resolveTier: (c) => asServerContext(c).var.apiKey.rateLimitTier,
    }),
  );

  app.post("/v1/risk/scan", async (c) => {
    if (!c.var.apiKey.scopes.includes("scan:write")) {
      c.var.log.warn({ required_scope: "scan:write" }, "auth_scope_denied");
      return c.json({ error: "forbidden" }, 403);
    }

    const body = scanRequestSchema.safeParse(await c.req.json());

    if (!body.success) {
      return c.json(
        {
          error: "invalid_request",
          issues: body.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        400,
      );
    }

    const classified = classifyInput(body.data.input);
    const inputHash = canonicalInputHash(classified);
    // Emulation runs against current blockchain state, so transaction-JSON
    // scans can't be safely served from cache when emulation is enabled —
    // see `isScanResultCacheable` for the full rationale.
    const cacheable = isScanResultCacheable(classified, {
      emulatorEnabled: options.emulator.enabled,
      telegramIntelEnabled: options.telegramIntel.enabled,
      mtprotoIntelEnabled: options.mtprotoIntel.enabled,
      fragmentEnabled: options.fragment.enabled,
    });
    const cached = cacheable ? await options.reports.findByInputHash(inputHash) : null;

    if (cached !== null) {
      c.var.log.info(
        { input_kind: cached.input.kind, verdict: cached.verdict, dedup_hit: true },
        "scan_resolved",
      );

      return c.json(cached);
    }

    const fresh = await createBasicScan({
      cache: manifestCache,
      emulator: options.emulator,
      telegramIntel: options.telegramIntel,
      mtprotoIntel: options.mtprotoIntel,
      telegramEntities: options.telegramEntities,
      telegramGiftCatalog: options.telegramGiftCatalog,
      fragment: options.fragment,
      fragmentCache: options.fragmentCache,
      rawInput: body.data.input,
    });
    // `ReportStore.save()` is dedup-aware: on input-hash conflict it
    // returns the existing row instead of writing the fresh one. For
    // emulation results that's wrong — the previously-stored report can be
    // stale (different seqno/balance/code) or carry a stuck
    // `EMULATION_NOT_CONFIGURED` from before the key was set. When
    // `cacheable === false`, we return the fresh report directly.
    const saved = cacheable ? await options.reports.save(fresh) : fresh;

    c.var.log.info(
      {
        input_kind: saved.input.kind,
        verdict: saved.verdict,
        risk_score: saved.riskScore,
        dedup_hit: cacheable && saved.id !== fresh.id,
        persisted: cacheable,
      },
      "scan_resolved",
    );

    return c.json(saved);
  });

  return app;
};
