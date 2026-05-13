import { describe, expect, it } from "vitest";
import { createLogger } from "@tonshield/logger";
import { createInMemoryRateLimiter, defaultTierLimits } from "@tonshield/rate-limit";
import {
  createInMemoryApiKeyStore,
  createInMemoryGiftCatalogStore,
  createInMemoryReportStore,
  createInMemoryTelegramEntityStore,
  createInMemoryTenantStore,
} from "@tonshield/storage";
import type { ApiKeyScope, ApiKeyStore, ReportStore } from "@tonshield/storage";
import { createTelegramIntelClient } from "@tonshield/telegram-intel";
import { createTonEmulatorClient } from "@tonshield/ton-emulator";
import { createApiServer } from "./server.ts";

interface TestSetup {
  readonly app: ReturnType<typeof createApiServer>;
  readonly apiKeys: ApiKeyStore;
  readonly reports: ReportStore;
  readonly rawKey: string;
}

const buildApp = async (
  options: {
    rawKey?: string;
    scopes?: readonly ApiKeyScope[];
    tier?: "free" | "partner" | "internal";
  } = {},
): Promise<TestSetup> => {
  const tenants = createInMemoryTenantStore();
  const apiKeys = createInMemoryApiKeyStore({
    keyGenerator: () => options.rawKey ?? "tsk_test_key",
  });
  const reports = createInMemoryReportStore();
  const tenant = await tenants.create({ name: "Test" });
  await apiKeys.create({
    tenantId: tenant.id,
    name: "primary",
    scopes: options.scopes ?? ["scan:write"],
    rateLimitTier: options.tier ?? "internal",
  });

  // Silent logger keeps tests quiet without spawning pino-pretty.
  const logger = createLogger({ service: "tonshield-api-test", level: "silent", pretty: false });

  // Tests run with emulation disabled (no `TONAPI_KEY`). Scans of
  // `transaction_json` inputs will surface `EMULATION_NOT_CONFIGURED`,
  // which existing assertions already tolerate.
  const emulator = createTonEmulatorClient({ apiKey: null, baseUrl: "https://tonapi.io" });

  // M3: same fail-soft posture for the Telegram intel client. Tests don't
  // set a token; Telegram-shaped scans surface
  // `TELEGRAM_BOT_API_NOT_CONFIGURED`.
  const telegramIntel = createTelegramIntelClient({
    token: null,
    apiBaseUrl: "https://api.telegram.org",
  });
  const telegramEntities = createInMemoryTelegramEntityStore();
  const telegramGiftCatalog = createInMemoryGiftCatalogStore();

  const app = createApiServer({
    logger,
    apiKeys,
    reports,
    rateLimiter: createInMemoryRateLimiter(),
    emulator,
    telegramIntel,
    telegramEntities,
    telegramGiftCatalog,
  });

  return { app, apiKeys, reports, rawKey: options.rawKey ?? "tsk_test_key" };
};

const scan = async (
  app: TestSetup["app"],
  body: Record<string, unknown>,
  rawKey: string | null,
): Promise<Response> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (rawKey !== null) {
    headers.Authorization = `Bearer ${rawKey}`;
  }

  return app.request("/v1/risk/scan", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
};

describe("createApiServer", () => {
  it("/health is public, unauthenticated, and unmetered", async () => {
    const { app } = await buildApp();

    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "tonshield-api" });
  });

  it("returns 401 on /v1/risk/scan without an API key", async () => {
    const { app } = await buildApp();

    const res = await scan(app, { input: "@test" }, null);

    expect(res.status).toBe(401);
  });

  it("scans a Telegram handle when authenticated", async () => {
    const { app, rawKey } = await buildApp();

    const res = await scan(app, { input: "@TONShieldBot" }, rawKey);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { input: { kind: string }; verdict: string };
    expect(body.input.kind).toBe("telegram_handle");
    expect(body.verdict).toBe("safe");
  });

  it("returns 400 on a malformed body", async () => {
    const { app, rawKey } = await buildApp();

    const res = await scan(app, { not_input: 1 }, rawKey);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("returns 403 when the API key lacks scan:write", async () => {
    const { app, rawKey } = await buildApp({ scopes: ["scan:read"] });

    const res = await scan(app, { input: "@TONShieldBot" }, rawKey);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("dedupes identical inputs: second scan returns the same id without a new save", async () => {
    const { app, reports, rawKey } = await buildApp();

    const first = await scan(app, { input: "@TONShieldBot" }, rawKey);
    const firstBody = (await first.json()) as { id: string };
    const second = await scan(app, { input: "@TONShieldBot" }, rawKey);
    const secondBody = (await second.json()) as { id: string };

    expect(secondBody.id).toBe(firstBody.id);

    // Verify only one record actually exists in the store.
    const found = await reports.findById(firstBody.id);
    expect(found?.id).toBe(firstBody.id);
  });

  it("dedupes across surface variants of the same canonical input", async () => {
    // Two TON Connect deep links that vary only in requestId hash to the same
    // canonical input, so the second should be a dedup hit.
    const { app, rawKey } = await buildApp();
    const baseRequest = encodeURIComponent(
      JSON.stringify({ manifestUrl: "https://example.com/tonconnect-manifest.json" }),
    );

    const first = await scan(app, { input: `tc://?id=req_a&r=${baseRequest}` }, rawKey);
    const firstBody = (await first.json()) as { id: string };
    const second = await scan(app, { input: `tc://?id=req_b&r=${baseRequest}` }, rawKey);
    const secondBody = (await second.json()) as { id: string };

    expect(secondBody.id).toBe(firstBody.id);
  });

  it("rate limits when the per-tenant bucket is drained (free tier)", async () => {
    // Free tier: bucketSize 30. Drain it fast by sending the same request 31 times.
    const { app, rawKey } = await buildApp({ tier: "free" });
    const headers = { "content-type": "application/json", Authorization: `Bearer ${rawKey}` };

    let lastStatus = 0;
    for (let i = 0; i < 31; i += 1) {
      const res = await app.request("/v1/risk/scan", {
        method: "POST",
        headers,
        body: JSON.stringify({ input: `@user_${String(i)}` }),
      });
      lastStatus = res.status;
    }

    expect(lastStatus).toBe(429);
  });

  it("emits X-RateLimit-* headers on success", async () => {
    const { app, rawKey } = await buildApp({ tier: "partner" });

    const res = await scan(app, { input: "@test" }, rawKey);

    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(defaultTierLimits.partner.bucketSize));
    expect(res.headers.get("X-RateLimit-Remaining")).toMatch(/^\d+$/);
  });
});
