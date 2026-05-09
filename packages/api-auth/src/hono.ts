import type { Context, MiddlewareHandler } from "hono";
import type { ApiKeyStore, ResolvedApiKey } from "@tonshield/storage";
import { extractApiKey } from "./extract-key.ts";

/**
 * Reason a request was rejected. Exposed only to the optional logging
 * hook — the 401 response shape is identical for all reasons so the API
 * doesn't leak whether a key exists or was once valid.
 */
export type AuthFailureReason = "missing_key" | "invalid_key";

/**
 * Variables this middleware attaches to the Hono context on success.
 * Consumers spread this into their app's `Variables` generic so
 * downstream handlers can read `c.var.apiKey` with full typing.
 */
export interface AuthVariables {
  readonly apiKey: ResolvedApiKey;
}

export interface CreateApiKeyAuthOptions {
  readonly apiKeys: ApiKeyStore;
  /**
   * Called when authentication fails. The middleware always returns the
   * same 401 response — this hook exists for logging / metrics. Errors
   * thrown here do not affect the response.
   */
  readonly onAuthFailure?: (reason: AuthFailureReason, c: Context) => void;
  /**
   * Called when authentication succeeds, before `next()`. Useful for
   * structured logging that wants the resolved tenant/key on every
   * request. Errors thrown here do not affect the response.
   */
  readonly onAuthSuccess?: (resolved: ResolvedApiKey, c: Context) => void;
  /**
   * If true (default), `touchLastUsed` is called fire-and-forget after
   * successful auth so the recency timestamp tracks usage without
   * blocking the response.
   */
  readonly trackLastUsed?: boolean;
}

/**
 * Hono middleware that authenticates requests via `Authorization: Bearer`
 * (preferred) or `X-API-Key`. On success: attaches `c.var.apiKey` with the
 * resolved key + tenant + scopes + tier. On failure: returns 401 with a
 * generic body and no detail about *why* it failed.
 *
 * Mount on protected paths only:
 *
 *   const auth = createApiKeyAuth({ apiKeys: storage.apiKeys });
 *   app.use("/v1/*", auth);
 *
 * `/health` and other public routes should not be wrapped.
 */
export const createApiKeyAuth = (
  options: CreateApiKeyAuthOptions,
): MiddlewareHandler<{ Variables: AuthVariables }> => {
  const { apiKeys, onAuthFailure, onAuthSuccess } = options;
  const trackLastUsed = options.trackLastUsed ?? true;

  return async (c, next) => {
    const rawKey = extractApiKey({
      authorization: c.req.header("Authorization"),
      apiKey: c.req.header("X-API-Key"),
    });

    if (rawKey === null) {
      safeCall(onAuthFailure, "missing_key", c);
      return c.json({ error: "unauthorized" }, 401);
    }

    const resolved = await apiKeys.verify(rawKey);

    if (resolved === null) {
      safeCall(onAuthFailure, "invalid_key", c);
      return c.json({ error: "unauthorized" }, 401);
    }

    c.set("apiKey", resolved);

    if (trackLastUsed) {
      // Fire-and-forget. Logging the failure is the operator's choice —
      // we don't want a Postgres blip to surface as a 5xx on the user.
      void apiKeys.touchLastUsed(resolved.id).catch(() => {
        // intentionally swallowed
      });
    }

    if (onAuthSuccess !== undefined) {
      try {
        onAuthSuccess(resolved, c);
      } catch {
        // Hooks must never break the request path.
      }
    }

    await next();
    return undefined;
  };
};

const safeCall = (
  hook: ((reason: AuthFailureReason, c: Context) => void) | undefined,
  reason: AuthFailureReason,
  c: Context,
): void => {
  if (hook === undefined) {
    return;
  }

  try {
    hook(reason, c);
  } catch {
    // intentionally swallowed
  }
};
