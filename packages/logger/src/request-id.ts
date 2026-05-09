import { randomUUID } from "node:crypto";

/**
 * Header used for upstream-supplied request IDs. We accept whatever the
 * upstream load balancer or API gateway provides, falling back to a fresh
 * UUID when absent. Standardizing on a single header keeps grep simple.
 */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Resolves a request ID for the current call:
 *   - If the upstream provided one and it's non-empty, reasonably sized,
 *     and safe to echo as an HTTP header, use it. This lets traces from a
 *     CDN/LB carry through.
 *   - Otherwise generate a fresh UUIDv4.
 *
 * The size cap (256 chars) prevents a malicious caller from polluting
 * logs with an arbitrarily long ID that costs bytes on every line. The
 * visible-ASCII check prevents control characters from being echoed into
 * response headers.
 */
export const resolveRequestId = (incoming?: string | null): string => {
  if (incoming === undefined || incoming === null) {
    return randomUUID();
  }

  const trimmed = incoming.trim();

  if (trimmed.length === 0 || trimmed.length > 256 || !isSafeHeaderValue(trimmed)) {
    return randomUUID();
  }

  return trimmed;
};

const isSafeHeaderValue = (value: string): boolean => /^[\x21-\x7E]+$/.test(value);
