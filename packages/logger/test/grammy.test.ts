import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createGrammyLogger } from "../src/grammy.ts";

interface CapturedLog {
  readonly level: string;
  readonly msg: string;
  readonly request_id?: string;
  readonly update_id?: number;
  readonly from_id?: number;
  readonly chat_id?: number;
  readonly update_type?: string;
  readonly err?: { message: string };
}

const buildLogger = () => {
  const records: CapturedLog[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, cb) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      records.push(JSON.parse(text) as CapturedLog);
      cb();
    },
  });
  const logger = pino(
    { base: { service: "test-bot" }, formatters: { level: (label) => ({ level: label }) } },
    stream,
  );

  return { logger, records };
};

interface FakeCtx {
  update: { update_id: number };
  message?: { text: string };
  callbackQuery?: undefined;
  inlineQuery?: undefined;
  editedMessage?: undefined;
  channelPost?: undefined;
  from?: { id: number };
  chat?: { id: number };
  log?: unknown;
  requestId?: string;
}

const ctx = (overrides: Partial<FakeCtx> = {}): FakeCtx => ({
  update: { update_id: 1 },
  message: { text: "hello" },
  from: { id: 42 },
  chat: { id: 100 },
  ...overrides,
});

describe("createGrammyLogger", () => {
  it("attaches a child logger and request id to ctx", async () => {
    const { logger } = buildLogger();
    const middleware = createGrammyLogger({ logger }) as unknown as (
      c: FakeCtx,
      next: () => Promise<void>,
    ) => Promise<void>;
    const c = ctx();

    await middleware(c, vi.fn().mockResolvedValue(undefined));

    expect(c.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.log).toBeDefined();
  });

  it("logs update_received with from_id, chat_id, update_type", async () => {
    const { logger, records } = buildLogger();
    const middleware = createGrammyLogger({ logger }) as unknown as (
      c: FakeCtx,
      next: () => Promise<void>,
    ) => Promise<void>;

    await middleware(ctx(), vi.fn().mockResolvedValue(undefined));

    const received = records.find((r) => r.msg === "update_received");
    expect(received).toMatchObject({
      level: "info",
      from_id: 42,
      chat_id: 100,
      update_type: "message",
    });
  });

  it("logs update_completed at info on success", async () => {
    const { logger, records } = buildLogger();
    const middleware = createGrammyLogger({ logger }) as unknown as (
      c: FakeCtx,
      next: () => Promise<void>,
    ) => Promise<void>;

    await middleware(ctx(), vi.fn().mockResolvedValue(undefined));

    const completed = records.find((r) => r.msg === "update_completed");
    expect(completed?.level).toBe("info");
  });

  it("logs update_failed at error and re-throws when next throws", async () => {
    const { logger, records } = buildLogger();
    const middleware = createGrammyLogger({ logger }) as unknown as (
      c: FakeCtx,
      next: () => Promise<void>,
    ) => Promise<void>;

    await expect(middleware(ctx(), () => Promise.reject(new Error("kaboom")))).rejects.toThrow(
      /kaboom/,
    );

    const failed = records.find((r) => r.msg === "update_failed");
    expect(failed?.level).toBe("error");
    expect(failed?.err?.message).toBe("kaboom");
  });

  it("classifies update_type as 'other' for unknown shapes", async () => {
    const { logger, records } = buildLogger();
    const middleware = createGrammyLogger({ logger }) as unknown as (
      c: FakeCtx,
      next: () => Promise<void>,
    ) => Promise<void>;
    // Build a context that has none of the known update fields populated.
    const bareCtx: FakeCtx = { update: { update_id: 99 } };

    await middleware(bareCtx, vi.fn().mockResolvedValue(undefined));

    const received = records.find((r) => r.msg === "update_received");
    expect(received?.update_type).toBe("other");
  });
});
