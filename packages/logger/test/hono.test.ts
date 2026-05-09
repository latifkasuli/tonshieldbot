import { Writable } from "node:stream";
import { Hono } from "hono";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { createHonoLogger } from "../src/hono.ts";
import type { LoggerVariables } from "../src/hono.ts";

interface CapturedLog {
  readonly level: string;
  readonly msg: string;
  readonly request_id?: string;
  readonly status?: number;
  readonly path?: string;
  readonly tenant_id?: string;
}

const buildApp = () => {
  const records: CapturedLog[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, cb) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      records.push(JSON.parse(text) as CapturedLog);
      cb();
    },
  });
  const logger = pino(
    { base: { service: "test" }, formatters: { level: (label) => ({ level: label }) } },
    stream,
  );
  const app = new Hono<{ Variables: LoggerVariables }>();
  app.use("*", createHonoLogger({ logger }));
  app.get("/ok", (c) => c.json({ requestId: c.var.requestId }));
  app.get("/rebind", (c) => {
    c.set("log", c.var.log.child({ tenant_id: "tenant_1" }));
    return c.json({ ok: true });
  });
  app.get("/missing", (c) => c.notFound());
  app.get("/boom", () => {
    throw new Error("boom");
  });
  app.onError((_err, c) => c.json({ error: "internal" }, 500));

  return { app, records };
};

describe("createHonoLogger", () => {
  it("attaches a request id and child logger to c.var", async () => {
    const { app } = buildApp();

    const res = await app.request("/ok");
    const body = (await res.json()) as { requestId: string };

    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("echoes the request id back via X-Request-Id", async () => {
    const { app } = buildApp();

    const res = await app.request("/ok");

    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("preserves an upstream X-Request-Id", async () => {
    const { app } = buildApp();

    const res = await app.request("/ok", { headers: { "X-Request-Id": "trace-from-lb" } });
    const body = (await res.json()) as { requestId: string };

    expect(body.requestId).toBe("trace-from-lb");
    expect(res.headers.get("X-Request-Id")).toBe("trace-from-lb");
  });

  it("logs request_started and request_completed at info for 2xx", async () => {
    const { app, records } = buildApp();

    await app.request("/ok");

    const messages = records.map((r) => ({ level: r.level, msg: r.msg }));
    expect(messages).toEqual([
      { level: "info", msg: "request_started" },
      { level: "info", msg: "request_completed" },
    ]);
  });

  it("logs at warn for 4xx", async () => {
    const { app, records } = buildApp();

    await app.request("/missing");

    const completed = records.find((r) => r.msg === "request_completed");
    expect(completed?.level).toBe("warn");
    expect(completed?.status).toBe(404);
  });

  it("logs at error for 5xx", async () => {
    const { app, records } = buildApp();

    await app.request("/boom");

    const completed = records.find((r) => r.msg === "request_completed");
    expect(completed?.level).toBe("error");
    expect(completed?.status).toBe(500);
  });

  it("binds request_id to every log line in the request scope", async () => {
    const { app, records } = buildApp();

    await app.request("/ok");

    const ids = new Set(records.map((r) => r.request_id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses a downstream-rebound child logger for request completion", async () => {
    const { app, records } = buildApp();

    await app.request("/rebind");

    const completed = records.find((r) => r.msg === "request_completed");
    expect(completed?.tenant_id).toBe("tenant_1");
  });
});
