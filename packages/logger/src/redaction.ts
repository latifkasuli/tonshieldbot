/**
 * Default redaction paths for pino. Pino traverses these paths on every log
 * record and replaces matching values with `[Redacted]`.
 *
 * Best-effort: callers must still avoid logging entire env objects, raw
 * request bodies, or anything containing user secrets. This list catches
 * the common accidental leaks.
 */
export const defaultRedactPaths: readonly string[] = [
  // HTTP auth surfaces — both pino-http style req.headers and a plain
  // headers object passed alongside other context.
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  "headers.authorization",
  'headers["x-api-key"]',
  "authorization",
  // Common secret-bearing env vars and config fields.
  "BOT_TOKEN",
  "DATABASE_URL",
  "REDIS_URL",
  "apiKey",
  "api_key",
  "rawKey",
  "*.BOT_TOKEN",
  "*.DATABASE_URL",
  "*.REDIS_URL",
  "*.password",
  "*.apiKey",
  "*.api_key",
  "*.rawKey",
];
