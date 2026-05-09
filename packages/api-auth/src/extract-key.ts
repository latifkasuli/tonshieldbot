/**
 * Extracts a raw API key from a request.
 *
 * Two accepted shapes, in priority order:
 *   1. `Authorization: Bearer <key>` — primary; works with OAuth-aware tooling.
 *   2. `X-API-Key: <key>` — fallback; common in Postman-style clients.
 *
 * Returns null if neither header is present or the Authorization header is
 * malformed. The middleware treats null as "no credentials presented".
 */
export const extractApiKey = (headers: {
  authorization?: string | undefined;
  apiKey?: string | undefined;
}): string | null => {
  const auth = headers.authorization?.trim();

  if (auth !== undefined && auth.length > 0) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(auth);

    if (match !== null) {
      return match[1] ?? null;
    }
    // Authorization is present but not Bearer-shaped — refuse to fall back to
    // X-API-Key. The caller picked their auth scheme; honour their choice and
    // return null so the middleware emits a clean 401.
    return null;
  }

  const apiKey = headers.apiKey?.trim();

  if (apiKey !== undefined && apiKey.length > 0) {
    return apiKey;
  }

  return null;
};
