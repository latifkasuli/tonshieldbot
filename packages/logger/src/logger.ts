import { pino } from "pino";
import type { Logger, LoggerOptions } from "pino";
import { defaultRedactPaths } from "./redaction.ts";

export type { Logger };

export const logLevels = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
export type LogLevel = (typeof logLevels)[number];

export interface CreateLoggerOptions {
  /**
   * Service name attached to every log line as `service`. Lets a single
   * log aggregator distinguish records from `tonshield-api` vs the bot
   * vs the worker.
   */
  readonly service: string;
  /**
   * Default log level. Falls back to env `LOG_LEVEL`, then `info`.
   */
  readonly level?: LogLevel;
  /**
   * Extra paths to redact in addition to `defaultRedactPaths`.
   */
  readonly redactPaths?: readonly string[];
  /**
   * Pretty-print to stdout when true. Production deployments should leave
   * this false so logs come out as JSON for ingestion. Defaults to true
   * only when `NODE_ENV !== "production"`.
   */
  readonly pretty?: boolean;
}

const isLogLevel = (value: string | undefined): value is LogLevel =>
  value !== undefined && (logLevels as readonly string[]).includes(value);

/**
 * Builds a pino logger with TON Shield's standard configuration. One per
 * service at startup; every per-request logger is a `.child()` of this one.
 */
export const createLogger = (options: CreateLoggerOptions): Logger => {
  const envLevel = process.env.LOG_LEVEL;
  const level = options.level ?? (isLogLevel(envLevel) ? envLevel : "info");
  const pretty = options.pretty ?? process.env.NODE_ENV !== "production";
  const redact: LoggerOptions["redact"] = {
    paths: [...defaultRedactPaths, ...(options.redactPaths ?? [])],
    censor: "[Redacted]",
  };

  const baseOptions: LoggerOptions = {
    level,
    base: { service: options.service },
    redact,
    formatters: {
      // pino's default level is numeric; the human label is friendlier in
      // log aggregators that don't translate the numbers.
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (pretty) {
    return pino({
      ...baseOptions,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          ignore: "pid,hostname,service",
          translateTime: "SYS:HH:MM:ss.l",
        },
      },
    });
  }

  return pino(baseOptions);
};
