/**
 * TONAPI failure classification for Fragment intel calls. Mirrors the
 * `classifyFailure` shape in `@tonshield/ton-emulator/src/emulate.ts`
 * so downstream consumers (the scanner that emits health rules) can
 * render emulator and Fragment failures with a consistent UI.
 *
 * We distinguish:
 *   - `not_found` — the DNS / NFT lookup returned no record. Different
 *     from a transport failure: it's a clean answer of "this username
 *     isn't a Fragment NFT". The scanner uses this to skip the handoff
 *     check silently rather than firing a health finding.
 *   - `rate_limited` — TONAPI 429. The static-only signal is still
 *     authoritative; we emit FRAGMENT_API_UNAVAILABLE at low severity.
 *   - `provider_down` — 5xx or network/timeout. Same handling.
 *   - `failed` — 4xx (non-429). Same handling.
 */

export type TonApiFailure =
  | {
      readonly status: "not_found";
      readonly description: string;
    }
  | {
      readonly status: "rate_limited";
      readonly httpStatus: 429;
    }
  | {
      readonly status: "provider_down";
      readonly httpStatus: number | null;
    }
  | {
      readonly status: "failed";
      readonly httpStatus: number;
    };

/**
 * Classify an error thrown by the `@ton-api/client` SDK. The SDK
 * normalises HTTP errors to `{ status: number, ... }` shapes, but
 * sometimes throws plain `Error` (e.g. network timeouts); both are
 * handled.
 */
export const classifyTonApiFailure = (error: unknown): TonApiFailure => {
  if (isNotFoundShape(error)) {
    return { status: "not_found", description: notFoundDescription(error) };
  }

  const httpStatus = extractHttpStatus(error);
  if (httpStatus === null) {
    return { status: "provider_down", httpStatus: null };
  }

  if (httpStatus === 404) {
    return { status: "not_found", description: notFoundDescription(error) };
  }

  if (httpStatus === 429) {
    return { status: "rate_limited", httpStatus: 429 };
  }

  if (httpStatus >= 500) {
    return { status: "provider_down", httpStatus };
  }

  if (httpStatus >= 400) {
    return { status: "failed", httpStatus };
  }

  return { status: "failed", httpStatus };
};

/**
 * Pull the HTTP status off whatever error shape TONAPI's SDK throws.
 *
 * Two shapes observed in the wild:
 *
 *   1. `{ status: number }` — what a hand-rolled mock or older SDK
 *      version would surface. Tests use this shape.
 *   2. `new Error(message, { cause: response })` — what
 *      `@ton-api/client@0.4` actually throws. The HTTP status lives on
 *      `error.cause.status` (the `cause` is the Fetch API `Response`
 *      object). This was the production crash path that pre-fix made
 *      every Telegram-handle scan emit a spurious
 *      `TELEGRAM_FRAGMENT_API_UNAVAILABLE` — a clean 404 (handle isn't
 *      a Fragment username) looked indistinguishable from a network
 *      failure because `error.status` was `undefined`.
 *
 * We check both. If neither carries a numeric status, we treat the
 * error as a transport-layer failure (provider_down with httpStatus
 * null), which is the right posture for genuine network drops.
 */
const extractHttpStatus = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const direct = (error as { status?: unknown }).status;
  if (typeof direct === "number") return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const causeStatus = (cause as { status?: unknown }).status;
    if (typeof causeStatus === "number") return causeStatus;
  }
  return null;
};

const isNotFoundShape = (error: unknown): boolean => extractHttpStatus(error) === 404;

const notFoundDescription = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "tonapi_not_found";
};
