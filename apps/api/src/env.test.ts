import { describe, expect, it } from "vitest";
import { loadApiConfig } from "./env.ts";

describe("loadApiConfig", () => {
  it("defaults to host 0.0.0.0 and port 3000 when no env is set", () => {
    expect(loadApiConfig({})).toEqual({
      host: "0.0.0.0",
      port: 3000,
      databaseUrl: undefined,
      redisUrl: undefined,
      telegramApiBaseUrl: undefined,
      telegramIntelBotToken: undefined,
      telegramMtprotoApiHash: undefined,
      telegramMtprotoApiId: undefined,
      telegramMtprotoBotToken: undefined,
      telegramMtprotoSession: undefined,
      tonApiBaseUrl: undefined,
      tonApiKey: undefined,
    });
  });

  it("honors PORT (Railway-style) when API_PORT is unset", () => {
    expect(loadApiConfig({ PORT: "8080" })).toMatchObject({
      host: "0.0.0.0",
      port: 8080,
    });
  });

  it("honors API_PORT when only API_PORT is set", () => {
    expect(loadApiConfig({ API_PORT: "9000" })).toMatchObject({
      host: "0.0.0.0",
      port: 9000,
    });
  });

  it("API_PORT wins when both API_PORT and PORT are set", () => {
    expect(loadApiConfig({ API_PORT: "9000", PORT: "8080" })).toMatchObject({
      port: 9000,
    });
  });

  it("honors API_HOST when set", () => {
    expect(loadApiConfig({ API_HOST: "127.0.0.1" })).toMatchObject({
      host: "127.0.0.1",
    });
  });

  it("passes DATABASE_URL through unchanged", () => {
    const cfg = loadApiConfig({ DATABASE_URL: "postgres://h/db" });

    expect(cfg.databaseUrl).toBe("postgres://h/db");
  });

  it("passes REDIS_URL through unchanged", () => {
    const cfg = loadApiConfig({ REDIS_URL: "redis://h:6379" });

    expect(cfg.redisUrl).toBe("redis://h:6379");
  });

  it("rejects a non-positive port", () => {
    expect(() => loadApiConfig({ PORT: "0" })).toThrow();
    expect(() => loadApiConfig({ API_PORT: "-1" })).toThrow();
  });

  it("rejects a non-numeric port", () => {
    expect(() => loadApiConfig({ PORT: "abc" })).toThrow();
  });
});
