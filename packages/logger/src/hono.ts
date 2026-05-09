import type { MiddlewareHandler } from "hono";
import type { Logger } from "pino";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id.ts";

/**
 * Variables this middleware attaches. Spread into the app's Hono generic
 * so handlers can read `c.var.log` and `c.var.requestId` with full typing.
 */
export interface LoggerVariables {
  readonly log: Logger;
  readonly requestId: string;
}

export interface CreateHonoLoggerOptions {
  readonly logger: Logger;
}

/**
 * Hono middleware that:
 *   - Resolves an upstream request ID or generates a UUID
 *   - Echoes it back via `X-Request-Id` so clients and downstream services
 *     can correlate
 *   - Attaches a child logger bound to `request_id` to `c.var.log`
 *   - Logs request start at `info` and request end at `info` (or `warn`
 *     for 4xx, `error` for 5xx) with status + duration
 */
export const createHonoLogger = (
  options: CreateHonoLoggerOptions,
): MiddlewareHandler<{
  Variables: LoggerVariables;
}> => {
  const baseLogger = options.logger;

  return async (c, next) => {
    const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
    const log = baseLogger.child({ request_id: requestId });
    c.set("requestId", requestId);
    c.set("log", log);
    c.header(REQUEST_ID_HEADER, requestId);

    const startedAt = process.hrtime.bigint();
    log.info({ method: c.req.method, path: c.req.path }, "request_started");

    try {
      await next();
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const status = c.res.status;
      // Downstream middleware may rebind `c.var.log` with auth/tenant fields.
      // Use the latest logger for completion so the final line carries the
      // same request-scoped context as handler logs.
      const completionLog = c.var.log;
      const fields = {
        method: c.req.method,
        path: c.req.path,
        status,
        duration_ms: Math.round(elapsedMs * 100) / 100,
      };

      if (status >= 500) {
        completionLog.error(fields, "request_completed");
      } else if (status >= 400) {
        completionLog.warn(fields, "request_completed");
      } else {
        completionLog.info(fields, "request_completed");
      }
    }
  };
};
