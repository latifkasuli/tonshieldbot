import type { Context as GrammyContext, MiddlewareFn } from "grammy";
import type { Logger } from "pino";
import { resolveRequestId } from "./request-id.ts";

/**
 * Context flavor consumers add to their grammy context type so
 * `ctx.log` and `ctx.requestId` are typed downstream.
 *
 *   import type { Context } from "grammy";
 *   import type { LoggerFlavor } from "@tonshield/logger";
 *
 *   type AppContext = Context & LoggerFlavor;
 */
export interface LoggerFlavor {
  log: Logger;
  requestId: string;
}

export interface CreateGrammyLoggerOptions {
  readonly logger: Logger;
}

/**
 * grammy middleware that attaches a child logger keyed on a per-update
 * request ID. Logs update receipt at `info`. Errors raised by downstream
 * handlers are logged at `error` and re-thrown so grammy's own error
 * handler still runs.
 */
export const createGrammyLogger = <
  C extends GrammyContext & LoggerFlavor = GrammyContext & LoggerFlavor,
>(
  options: CreateGrammyLoggerOptions,
): MiddlewareFn<C> => {
  const baseLogger = options.logger;

  return async (ctx, next) => {
    const requestId = resolveRequestId(null);
    const log = baseLogger.child({
      request_id: requestId,
      update_id: ctx.update.update_id,
      from_id: ctx.from?.id,
      chat_id: ctx.chat?.id,
    });

    ctx.requestId = requestId;
    ctx.log = log;

    const startedAt = process.hrtime.bigint();
    log.info({ update_type: detectUpdateType(ctx) }, "update_received");

    try {
      await next();
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      log.info({ duration_ms: Math.round(elapsedMs * 100) / 100 }, "update_completed");
    } catch (error: unknown) {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      log.error(
        {
          err: error,
          duration_ms: Math.round(elapsedMs * 100) / 100,
        },
        "update_failed",
      );
      throw error;
    }
  };
};

/**
 * Best-effort summary of which kind of update we're handling, for log
 * filtering. Falls back to "other" rather than the raw update keys to
 * keep cardinality low.
 */
const detectUpdateType = (ctx: GrammyContext): string => {
  if (ctx.message !== undefined) return "message";
  if (ctx.callbackQuery !== undefined) return "callback_query";
  if (ctx.inlineQuery !== undefined) return "inline_query";
  if (ctx.editedMessage !== undefined) return "edited_message";
  if (ctx.channelPost !== undefined) return "channel_post";
  return "other";
};
