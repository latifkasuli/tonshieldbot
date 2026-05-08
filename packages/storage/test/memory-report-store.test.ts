import { describe, expect, it } from "vitest";
import type { ScanReport, TonConnectLinkInput } from "@tonshield/shared";
import { canonicalInputHash } from "../src/canonical-hash.ts";
import { createInMemoryReportStore } from "../src/memory/report-store.ts";

const buildInput = (manifestUrl = "https://example.com/m.json"): TonConnectLinkInput => ({
  kind: "tonconnect_link",
  raw: `tc://?r=${encodeURIComponent(JSON.stringify({ manifestUrl }))}`,
  normalized: `tc://?r=${encodeURIComponent(JSON.stringify({ manifestUrl }))}`,
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

describe("createInMemoryReportStore", () => {
  it("save returns the persisted report and findById round-trips", async () => {
    const store = createInMemoryReportStore();
    const report = buildReport("a");

    const saved = await store.save(report);

    expect(saved).toBe(report);
    expect(await store.findById("a")).toEqual(report);
  });

  it("findById returns null for unknown ids", async () => {
    const store = createInMemoryReportStore();

    expect(await store.findById("missing")).toBeNull();
  });

  it("findByInputHash returns the report saved for that canonical input", async () => {
    const store = createInMemoryReportStore();
    const input = buildInput();
    const report = buildReport("a", input);
    await store.save(report);

    const found = await store.findByInputHash(canonicalInputHash(input));

    expect(found).toEqual(report);
  });

  it("save returns the existing report when a duplicate inputHash is written", async () => {
    const store = createInMemoryReportStore();
    const sharedInput = buildInput();
    const first = buildReport("first", sharedInput);
    const second = buildReport("second", sharedInput, { summary: "different copy" });

    await store.save(first);
    const result = await store.save(second);

    // The dedup contract: caller gets back the canonical (existing) record,
    // and the second write's content is discarded.
    expect(result).toBe(first);
    expect(await store.findById("second")).toBeNull();
  });

  it("treats different manifest URLs as different inputs", async () => {
    const store = createInMemoryReportStore();
    const a = buildReport("a", buildInput("https://a.example/m.json"));
    const b = buildReport("b", buildInput("https://b.example/m.json"));

    await store.save(a);
    await store.save(b);

    expect(await store.findById("a")).toEqual(a);
    expect(await store.findById("b")).toEqual(b);
  });
});
