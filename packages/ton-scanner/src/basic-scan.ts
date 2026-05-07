import { randomUUID } from "node:crypto";
import {
  confidenceFromFindings,
  createFinding,
  createScanReport,
  getCoreRule,
  scoreFindings,
  verdictFromScore,
} from "@tonshield/risk-engine";
import type { ActionPreview, RiskFinding, ScanInput, ScanReport } from "@tonshield/shared";
import type { FetchCache } from "@tonshield/safe-fetch";
import { classifyInput } from "./classify-input.ts";
import { scanTonConnectManifest } from "./manifest-scanner.ts";
import { scanTransactionJson } from "./transaction/scanner.ts";

export interface CreateBasicScanInput {
  readonly id?: string;
  readonly rawInput: string;
  readonly now?: Date;
  readonly cache?: FetchCache;
}

interface GatherResult {
  readonly findings: readonly RiskFinding[];
  readonly actions: readonly ActionPreview[];
}

export const createBasicScan = async (input: CreateBasicScanInput): Promise<ScanReport> => {
  const id = input.id ?? randomUUID();
  const classifiedInput = classifyInput(input.rawInput);
  const { findings, actions } = await gatherScanResult(classifiedInput, input.cache);
  const riskScore = scoreFindings(findings);
  const verdict = classifiedInput.kind === "unknown" ? "unknown" : verdictFromScore(riskScore);

  const reportInput = {
    id,
    input: classifiedInput,
    verdict,
    riskScore,
    confidence: confidenceFromFindings(findings),
    summary: summarizeInput(classifiedInput, findings),
    findings,
    actions,
    ...(input.now === undefined ? {} : { now: input.now }),
  };

  return createScanReport(reportInput);
};

const gatherScanResult = async (input: ScanInput, cache?: FetchCache): Promise<GatherResult> => {
  if (input.kind === "unknown") {
    return {
      findings: [
        createFinding({
          confidence: "medium",
          evidence: { reason: input.reason },
          rule: getCoreRule("INPUT_UNKNOWN"),
        }),
      ],
      actions: [],
    };
  }

  if (input.kind === "tonconnect_link") {
    const { findings } = await scanTonConnectManifest(input.manifestUrl, cache);

    return { findings, actions: [] };
  }

  if (input.kind === "transaction_json") {
    return scanTransactionJson(input);
  }

  return { findings: [], actions: [] };
};

const summarizeInput = (input: ScanInput, findings: readonly RiskFinding[]): string => {
  if (input.kind === "unknown") {
    return "TON Shield could not classify this input yet.";
  }

  if (input.kind === "transaction_json") {
    if (findings.length === 0) {
      return "Transaction JSON scanned. No risk signals detected.";
    }
  }

  if (findings.length === 0) {
    return `Scanned as ${input.kind}. No risk signals detected.`;
  }

  const topFinding = findings.reduce((top, finding) =>
    finding.scoreDelta > top.scoreDelta ? finding : top,
  );

  return topFinding.title;
};
