import { eq } from "drizzle-orm";
import type {
  ActionPreview,
  RiskFinding,
  ScanInput,
  ScanReport,
  Verdict,
  ConfidenceLevel,
} from "@tonshield/shared";
import { canonicalInputHash } from "../canonical-hash.ts";
import type { ReportStore } from "../interfaces/report-store.ts";
import type { StorageDb } from "./client.ts";
import { reports } from "./schema.ts";
import { deserializeInput, serializeInput } from "./serialize.ts";

interface DbReport {
  readonly id: string;
  readonly inputHash: string;
  readonly input: unknown;
  readonly verdict: string;
  readonly riskScore: number;
  readonly confidence: string;
  readonly summary: string;
  readonly findings: unknown;
  readonly actions: unknown;
  readonly createdAt: Date;
}

const toReport = (row: DbReport): ScanReport => ({
  id: row.id,
  createdAt: row.createdAt.toISOString(),
  input: deserializeInput(row.input),
  verdict: row.verdict as Verdict,
  riskScore: row.riskScore,
  confidence: row.confidence as ConfidenceLevel,
  summary: row.summary,
  findings: row.findings as readonly RiskFinding[],
  actions: row.actions as readonly ActionPreview[],
});

const toRow = (report: ScanReport, inputHash: string) => ({
  id: report.id,
  inputHash,
  input: serializeInput(report.input),
  verdict: report.verdict,
  riskScore: report.riskScore,
  confidence: report.confidence,
  summary: report.summary,
  findings: report.findings,
  actions: report.actions,
  createdAt: new Date(report.createdAt),
});

const inputHashOf = (input: ScanInput): string => canonicalInputHash(input);

export const createPostgresReportStore = (db: StorageDb): ReportStore => ({
  async save(report) {
    const inputHash = inputHashOf(report.input);

    // Insert-or-noop on the inputHash unique constraint. If a row already
    // exists we re-fetch it and return that as the canonical record per
    // the interface contract.
    const inserted = await db
      .insert(reports)
      .values(toRow(report, inputHash))
      .onConflictDoNothing({ target: reports.inputHash })
      .returning();

    if (inserted.length > 0) {
      const row = inserted[0];

      if (row !== undefined) {
        return toReport(row);
      }
    }

    const existing = await db
      .select()
      .from(reports)
      .where(eq(reports.inputHash, inputHash))
      .limit(1);
    const row = existing[0];

    if (row === undefined) {
      // Should be unreachable — the conflict implies a row exists. If it's
      // gone, surface the inconsistency rather than silently retrying.
      throw new Error(`Report with inputHash ${inputHash} vanished after conflict`);
    }

    return toReport(row);
  },

  async findById(id) {
    const rows = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
    const row = rows[0];

    return row === undefined ? null : toReport(row);
  },

  async findByInputHash(inputHash) {
    const rows = await db.select().from(reports).where(eq(reports.inputHash, inputHash)).limit(1);
    const row = rows[0];

    return row === undefined ? null : toReport(row);
  },
});
