import { Api } from "grammy";
import type { TelegramIntelConfig } from "./config.ts";

const TELEGRAM_INTEL_REQUEST_TIMEOUT_SECONDS = 20;

/**
 * Thin wrapper around grammY's `Api` class — the low-level Bot API HTTP
 * client without the full `Bot` framework wrapper. We expose the underlying
 * client for now and layer our own typed read methods on top in PR-2
 * (entity-resolver, snapshots) and PR-6 (gift catalog and inventory).
 *
 * Keeping this indirection means the rest of the codebase imports from
 * `@tonshield/telegram-intel`, not directly from `grammy`, so swapping
 * libraries later (or adding a local Bot API server fallback) is a single-
 * package change.
 *
 * `enabled` is the load-bearing flag for callers. When false, no HTTP calls
 * should be made — surface `TELEGRAM_BOT_API_NOT_CONFIGURED` instead. The
 * underlying `Api` is still constructed (with a placeholder token) so the
 * type surface stays uniform; calling into it while `enabled === false`
 * would yield an `Unauthorized` error from Telegram, which is undesirable
 * and avoidable by checking the flag.
 */
export interface TelegramIntelClient {
  /** True iff a non-empty Bot API token was provided. */
  readonly enabled: boolean;
  /** The underlying grammY Api client. Use only inside this package. */
  readonly raw: Api;
  /** Configured base URL — used for evidence breadcrumbs in failure findings. */
  readonly apiBaseUrl: string;
}

/**
 * Build a Telegram intel client from validated config. Always returns a
 * client; `enabled` is `false` when no token was provided. Callers should
 * branch on `enabled` and short-circuit to static-only handling when false.
 *
 * The constructed `Api` instance is harmless when disabled: grammY does not
 * make any network calls at construction time. A placeholder token is used
 * to satisfy grammY's type — `Api.config.use` for runtime token override
 * exists but adds complexity we don't need here.
 */
export const createTelegramIntelClient = (config: TelegramIntelConfig): TelegramIntelClient => {
  const tokenForConstructor = config.token ?? "DISABLED:placeholder";
  const raw = new Api(tokenForConstructor, {
    apiRoot: config.apiBaseUrl,
    fetch: createTelegramIntelFetch(),
    timeoutSeconds: TELEGRAM_INTEL_REQUEST_TIMEOUT_SECONDS,
  });

  return {
    enabled: config.token !== null,
    raw,
    apiBaseUrl: config.apiBaseUrl,
  };
};

const createTelegramIntelFetch = (): typeof fetch => {
  return async (input, init) => {
    const upstreamSignal = init?.signal;
    if (upstreamSignal == null) {
      return await globalThis.fetch(input, init);
    }

    // Same production-bundle issue as the long-polling bot: grammY's
    // Node shim may create an AbortSignal from the `abort-controller`
    // package while the fetch implementation checks against Node's native
    // AbortSignal class. Translate to a native signal before calling
    // Node 24 fetch so Telegram intel calls don't fail before the network.
    const controller = new globalThis.AbortController();
    const abort = () => {
      controller.abort(upstreamSignal.reason);
    };
    if (upstreamSignal.aborted) {
      abort();
    } else {
      upstreamSignal.addEventListener("abort", abort, { once: true });
    }

    try {
      return await globalThis.fetch(input, { ...init, signal: controller.signal });
    } finally {
      upstreamSignal.removeEventListener("abort", abort);
    }
  };
};
