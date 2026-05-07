import {
  confidenceFromFindings,
  createFinding,
  createScanReport,
  getCoreRule,
  scoreFindings,
  verdictFromScore,
} from "@tonshield/risk-engine";
import type { RiskFinding, ScanInput, ScanReport } from "@tonshield/shared";
import { classifyInput } from "./classify-input.ts";

export interface CreateBasicScanInput {
  readonly id: string;
  readonly rawInput: string;
  readonly now?: Date;
}

export const createBasicScan = (input: CreateBasicScanInput): ScanReport => {
  const classifiedInput = classifyInput(input.rawInput);
  const findings = createInputFindings(classifiedInput);
  const riskScore = scoreFindings(findings);
  const verdict = classifiedInput.kind === "unknown" ? "unknown" : verdictFromScore(riskScore);

  const reportInput = {
    id: input.id,
    input: classifiedInput,
    verdict,
    riskScore,
    confidence: confidenceFromFindings(findings),
    summary: summarizeInput(classifiedInput, findings),
    findings,
    ...(input.now === undefined ? {} : { now: input.now }),
  };

  return createScanReport(reportInput);
};

const createInputFindings = (input: ScanInput): readonly RiskFinding[] => {
  if (input.kind !== "unknown") {
    return [];
  }

  return [
    createFinding({
      rule: getCoreRule("INPUT_UNKNOWN"),
      confidence: "medium",
      evidence: {
        reason: input.reason,
      },
    }),
  ];
};

const summarizeInput = (input: ScanInput, findings: readonly RiskFinding[]): string => {
  if (input.kind === "unknown") {
    return "TON Shield could not classify this input yet.";
  }

  if (findings.length === 0) {
    return `TON Shield recognized this as ${input.kind}. No high-risk behavior has been evaluated yet.`;
  }

  return findings[0]?.title ?? "TON Shield generated a preliminary scan report.";
};
