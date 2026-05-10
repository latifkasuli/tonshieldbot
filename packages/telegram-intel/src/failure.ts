/**
 * Bot API failure classification. Mirrors the M2 PR-D1 classifier in
 * `@tonshield/ton-scanner/src/transaction/emulation-scanner.ts` so downstream
 * consumers can render either provider's failures with a consistent UI.
 *
 * Bot API error shape (per <https://core.telegram.org/bots/api#making-requests>):
 *   {
 *     "ok": false,
 *     "error_code": 400,
 *     "description": "Bad Request: chat not found",
 *     "parameters": { "retry_after": 5 }   // only on 429
 *   }
 *
 * grammY surfaces these as `GrammyError` instances with `.error_code`,
 * `.description`, and `.parameters` properties. We classify defensively by
 * structural shape rather than `instanceof GrammyError` so we survive
 * library version drift and direct-fetch fallbacks.
 *
 * The "chat not found" 400 response is structurally indistinguishable on
 * the wire from "you don't have access to that chat". Telegram does not
 * differentiate; we surface it as `not_resolvable` and let the scanner
 * layer add the `reason` discriminator (`channel_or_supergroup_not_found`
 * vs `user_or_bot_handle_requires_prior_context`) based on the input kind
 * the user submitted.
 */

export type BotApiFailure =
  | {
      readonly status: "not_resolvable";
      readonly description: string;
    }
  | {
      readonly status: "rate_limited";
      readonly httpStatus: 429;
      /** Seconds to wait per Bot API `parameters.retry_after`. May be `null` if not provided. */
      readonly retryAfter: number | null;
    }
  | {
      readonly status: "provider_down";
      /** HTTP status code, or `null` for network/timeout errors. */
      readonly httpStatus: number | null;
    }
  | {
      readonly status: "failed";
      readonly httpStatus: number;
      readonly description: string;
    };

/**
 * "chat not found" descriptions that should surface as `not_resolvable`
 * rather than the generic `failed` 400 bucket. Match prefixes so future
 * Telegram-side wording drift (e.g. trailing punctuation) doesn't bypass
 * the classifier silently.
 */
const NOT_RESOLVABLE_DESCRIPTION_PREFIXES: readonly string[] = [
  "Bad Request: chat not found",
  "Bad Request: USER_NOT_FOUND",
  "Bad Request: USERNAME_NOT_OCCUPIED",
];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const readNumber = (obj: Readonly<Record<string, unknown>> | null, key: string): number | null => {
  if (obj === null) {
    return null;
  }
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const readString = (obj: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = obj[key];
  return typeof value === "string" ? value : null;
};

const readRecord = (
  obj: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | null => {
  const value = obj[key];
  return isRecord(value) ? value : null;
};

export const classifyBotApiFailure = (error: unknown): BotApiFailure => {
  if (!isRecord(error)) {
    return { status: "provider_down", httpStatus: null };
  }

  const errorCode = readNumber(error, "error_code");
  const description = readString(error, "description") ?? "";
  const parameters = readRecord(error, "parameters");

  if (errorCode === 429) {
    return {
      status: "rate_limited",
      httpStatus: 429,
      retryAfter: readNumber(parameters, "retry_after"),
    };
  }

  if (errorCode === 400 && isNotResolvableDescription(description)) {
    return { status: "not_resolvable", description };
  }

  if (errorCode !== null && errorCode >= 500) {
    return { status: "provider_down", httpStatus: errorCode };
  }

  if (errorCode !== null && errorCode >= 400) {
    return { status: "failed", httpStatus: errorCode, description };
  }

  // No HTTP status — typically a network error, DNS failure, or aborted
  // request before the server responded. Treat as provider-down rather
  // than failed; the static decode is still authoritative and the user
  // can retry shortly.
  return { status: "provider_down", httpStatus: null };
};

const isNotResolvableDescription = (description: string): boolean =>
  NOT_RESOLVABLE_DESCRIPTION_PREFIXES.some((prefix) => description.startsWith(prefix));
