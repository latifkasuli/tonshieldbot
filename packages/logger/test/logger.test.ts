import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { defaultRedactPaths } from "../src/redaction.ts";

/**
 * The `createLogger` helper wraps pino with options + redaction. The
 * redaction itself is what we care about; building a pino logger directly
 * with the same paths lets us assert behavior without spawning the
 * pino-pretty transport (which uses worker_threads and is awkward in
 * vitest's worker pool).
 */
const buildCapture = () => {
  const records: unknown[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, cb) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      records.push(JSON.parse(text));
      cb();
    },
  });

  const logger = pino(
    {
      base: { service: "test" },
      redact: { paths: [...defaultRedactPaths], censor: "[Redacted]" },
      formatters: { level: (label) => ({ level: label }) },
    },
    stream,
  );

  return { logger, records };
};

describe("default redaction", () => {
  it("redacts Authorization headers", () => {
    const { logger, records } = buildCapture();

    logger.info({ req: { headers: { authorization: "Bearer secret" } } }, "test");

    const fields = records[0] as { req: { headers: { authorization: string } } };
    expect(fields.req.headers.authorization).toBe("[Redacted]");
  });

  it("redacts X-API-Key headers", () => {
    const { logger, records } = buildCapture();

    logger.info({ req: { headers: { "x-api-key": "tsk_secret" } } }, "test");

    const fields = records[0] as { req: { headers: { "x-api-key": string } } };
    expect(fields.req.headers["x-api-key"]).toBe("[Redacted]");
  });

  it("redacts a top-level apiKey field", () => {
    const { logger, records } = buildCapture();

    logger.info({ user: { apiKey: "tsk_secret" } }, "test");

    const fields = records[0] as { user: { apiKey: string } };
    expect(fields.user.apiKey).toBe("[Redacted]");
  });

  it("redacts a rawKey field nested one level deep", () => {
    const { logger, records } = buildCapture();

    logger.info({ created: { rawKey: "tsk_should_not_appear" } }, "test");

    const fields = records[0] as { created: { rawKey: string } };
    expect(fields.created.rawKey).toBe("[Redacted]");
  });

  it("redacts BOT_TOKEN and DATABASE_URL when nested under env-shaped objects", () => {
    const { logger, records } = buildCapture();

    logger.info({ env: { BOT_TOKEN: "123:abc", DATABASE_URL: "postgres://u:p@h/db" } }, "test");

    const fields = records[0] as {
      env: { BOT_TOKEN: string; DATABASE_URL: string };
    };
    expect(fields.env.BOT_TOKEN).toBe("[Redacted]");
    expect(fields.env.DATABASE_URL).toBe("[Redacted]");
  });

  it("redacts top-level secret fields", () => {
    const { logger, records } = buildCapture();

    logger.info({ BOT_TOKEN: "123:abc", rawKey: "tsk_secret" }, "test");

    const fields = records[0] as { BOT_TOKEN: string; rawKey: string };
    expect(fields.BOT_TOKEN).toBe("[Redacted]");
    expect(fields.rawKey).toBe("[Redacted]");
  });

  it("does not affect unrelated fields", () => {
    const { logger, records } = buildCapture();

    logger.info({ user: { tenantId: "abc", scopes: ["scan:read"] } }, "test");

    const fields = records[0] as { user: { tenantId: string; scopes: string[] } };
    expect(fields.user.tenantId).toBe("abc");
    expect(fields.user.scopes).toEqual(["scan:read"]);
  });
});
