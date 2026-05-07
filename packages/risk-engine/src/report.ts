import type { CreateReportInput, ScanReport } from "@tonshield/shared";

export const createScanReport = (input: CreateReportInput): ScanReport => ({
  id: input.id,
  createdAt: (input.now ?? new Date()).toISOString(),
  input: input.input,
  verdict: input.verdict,
  riskScore: input.riskScore,
  confidence: input.confidence,
  summary: input.summary,
  findings: input.findings,
  actions: input.actions ?? [],
});
