import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ScanReport, TonConnectLinkInput } from "@tonshield/shared";
import { canonicalInputHash } from "../src/canonical-hash.ts";
import {
  createPostgresApiKeyStore,
  createPostgresClient,
  createPostgresReportStore,
  createPostgresTenantStore,
} from "../src/postgres/index.ts";
import type { PostgresClient } from "../src/postgres/index.ts";

/**
 * Integration tests against a real Postgres. Skipped unless the operator
 * sets `TEST_DATABASE_URL` and has applied the migrations to that database.
 *
 *   TEST_DATABASE_URL=postgres://localhost/tonshield_test \
 *     pnpm --filter @tonshield/storage migrate:apply
 *
 * CI will skip these until a Postgres service is added to the workflow.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

const buildInput = (manifestUrl = "https://example.com/m.json"): TonConnectLinkInput => ({
  kind: "tonconnect_link",
  raw: "tc://?r=",
  normalized: "tc://?r=",
  manifestUrl: new URL(manifestUrl),
  requestId: null,
  returnStrategy: null,
});

const buildReport = (
  id: string,
  input: TonConnectLinkInput = buildInput(),
  overrides: Partial<ScanReport> = {},
): ScanReport => ({
  id,
  createdAt: "2026-05-07T12:00:00.000Z",
  input,
  verdict: "safe",
  riskScore: 0,
  confidence: "high",
  summary: `report ${id}`,
  findings: [],
  actions: [],
  ...overrides,
});

// Stable test UUIDs so every scenario is deterministic.
const REPORT_ID_A = "11111111-1111-4111-8111-111111111111";
const REPORT_ID_B = "22222222-2222-4222-8222-222222222222";

describe.skipIf(databaseUrl === undefined || databaseUrl.length === 0)(
  "Postgres-backed storage",
  () => {
    let client: PostgresClient | undefined;
    const requireClient = (): PostgresClient => {
      if (client === undefined) {
        throw new Error("Postgres client not initialized");
      }
      return client;
    };

    beforeAll(() => {
      if (databaseUrl === undefined) {
        return;
      }
      client = createPostgresClient({ databaseUrl });
    });

    afterAll(async () => {
      await client?.close();
    });

    beforeEach(async () => {
      // Cascade clears api_keys via FK. reports has no FKs so we list it
      // explicitly. Using TRUNCATE keeps tests fast versus DELETE.
      await requireClient().db.execute(
        sql`TRUNCATE TABLE api_keys, reports, tenants RESTART IDENTITY CASCADE`,
      );
    });

    describe("TenantStore", () => {
      it("creates a tenant with a generated id and createdAt", async () => {
        const store = createPostgresTenantStore(requireClient().db);

        const tenant = await store.create({ name: "Acme" });

        expect(tenant.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(tenant.name).toBe("Acme");
        expect(tenant.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });

      it("findById returns null for a missing tenant", async () => {
        const store = createPostgresTenantStore(requireClient().db);

        expect(await store.findById("00000000-0000-4000-8000-000000000000")).toBeNull();
      });
    });

    describe("ApiKeyStore", () => {
      it("create persists only the hash; verify resolves the active key", async () => {
        const tenants = createPostgresTenantStore(requireClient().db);
        const keys = createPostgresApiKeyStore(requireClient().db, {
          keyGenerator: () => "tsk_secret_value",
        });
        const tenant = await tenants.create({ name: "Acme" });

        const created = await keys.create({
          tenantId: tenant.id,
          name: "primary",
          scopes: ["scan:write"],
          rateLimitTier: "internal",
        });

        expect(created.rawKey).toBe("tsk_secret_value");
        const resolved = await keys.verify("tsk_secret_value");
        expect(resolved?.tenantId).toBe(tenant.id);
        expect(resolved?.scopes).toEqual(["scan:write"]);
        expect(resolved?.rateLimitTier).toBe("internal");
      });

      it("verify returns null for a revoked key", async () => {
        const tenants = createPostgresTenantStore(requireClient().db);
        const keys = createPostgresApiKeyStore(requireClient().db, {
          keyGenerator: () => "tsk_revokeable",
        });
        const tenant = await tenants.create({ name: "T" });
        const created = await keys.create({
          tenantId: tenant.id,
          name: "x",
          scopes: ["scan:read"],
          rateLimitTier: "free",
        });

        await keys.revoke(created.metadata.id);

        expect(await keys.verify("tsk_revokeable")).toBeNull();
      });

      it("revoke is idempotent and preserves the original revokedAt", async () => {
        const tenants = createPostgresTenantStore(requireClient().db);
        const keys = createPostgresApiKeyStore(requireClient().db);
        const tenant = await tenants.create({ name: "T" });
        const created = await keys.create({
          tenantId: tenant.id,
          name: "x",
          scopes: [],
          rateLimitTier: "free",
        });

        await keys.revoke(created.metadata.id);
        const first = (await keys.findById(created.metadata.id))?.revokedAt;

        await keys.revoke(created.metadata.id);
        const second = (await keys.findById(created.metadata.id))?.revokedAt;

        expect(first).toBeTruthy();
        expect(second).toBe(first);
      });

      it("revoke throws on an unknown id", async () => {
        const keys = createPostgresApiKeyStore(requireClient().db);

        await expect(keys.revoke("00000000-0000-4000-8000-000000000000")).rejects.toThrow(
          /not found/i,
        );
      });

      it("FK cascade: deleting a tenant removes its api_keys", async () => {
        const tenants = createPostgresTenantStore(requireClient().db);
        const keys = createPostgresApiKeyStore(requireClient().db);
        const tenant = await tenants.create({ name: "T" });
        const created = await keys.create({
          tenantId: tenant.id,
          name: "x",
          scopes: [],
          rateLimitTier: "free",
        });

        await requireClient().db.execute(sql`DELETE FROM tenants WHERE id = ${tenant.id}`);

        expect(await keys.findById(created.metadata.id)).toBeNull();
      });
    });

    describe("ReportStore", () => {
      it("save persists a report and findById/findByInputHash both retrieve it", async () => {
        const reports = createPostgresReportStore(requireClient().db);
        const input = buildInput();
        const report = buildReport(REPORT_ID_A, input);

        const saved = await reports.save(report);

        expect(saved.id).toBe(REPORT_ID_A);
        expect(await reports.findById(REPORT_ID_A)).toMatchObject({ id: REPORT_ID_A });
        expect(await reports.findByInputHash(canonicalInputHash(input))).toMatchObject({
          id: REPORT_ID_A,
        });
      });

      it("save returns the existing record on inputHash conflict and discards the new write", async () => {
        const reports = createPostgresReportStore(requireClient().db);
        const input = buildInput();
        const first = buildReport(REPORT_ID_A, input);
        const second = buildReport(REPORT_ID_B, input, { summary: "different copy" });

        await reports.save(first);
        const result = await reports.save(second);

        expect(result.id).toBe(REPORT_ID_A);
        expect(await reports.findById(REPORT_ID_B)).toBeNull();
      });

      it("rebuilds URL instances on read", async () => {
        const reports = createPostgresReportStore(requireClient().db);
        const input = buildInput("https://identity-test.example/m.json");
        await reports.save(buildReport(REPORT_ID_A, input));

        const fetched = await reports.findById(REPORT_ID_A);

        expect(fetched?.input.kind).toBe("tonconnect_link");
        if (fetched?.input.kind === "tonconnect_link") {
          expect(fetched.input.manifestUrl).toBeInstanceOf(URL);
          expect(fetched.input.manifestUrl.hostname).toBe("identity-test.example");
        }
      });
    });
  },
);
