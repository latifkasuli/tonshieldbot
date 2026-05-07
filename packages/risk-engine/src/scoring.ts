import type { ConfidenceLevel, RiskFinding, Severity, Verdict } from "@tonshield/shared";

const severityWeights = {
  info: 5,
  low: 10,
  medium: 25,
  high: 45,
  critical: 70,
} as const satisfies Record<Severity, number>;

export const clampRiskScore = (score: number): number => Math.max(0, Math.min(100, score));

export const scoreFindings = (findings: readonly RiskFinding[]): number => {
  const score = findings.reduce((total, finding) => total + finding.scoreDelta, 0);
  return clampRiskScore(score);
};

export const fallbackScoreDelta = (severity: Severity): number => severityWeights[severity];

export const verdictFromScore = (score: number): Verdict => {
  if (score >= 80) {
    return "critical";
  }

  if (score >= 60) {
    return "high";
  }

  if (score >= 40) {
    return "caution";
  }

  if (score >= 20) {
    return "info";
  }

  return "safe";
};

export const confidenceFromFindings = (findings: readonly RiskFinding[]): ConfidenceLevel => {
  if (findings.some((finding) => finding.confidence === "high")) {
    return "high";
  }

  if (findings.some((finding) => finding.confidence === "medium")) {
    return "medium";
  }

  return "low";
};
