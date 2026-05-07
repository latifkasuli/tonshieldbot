export const verdicts = ["safe", "info", "caution", "high", "critical", "unknown"] as const;
export type Verdict = (typeof verdicts)[number];

export const severities = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof severities)[number];

export const confidenceLevels = ["low", "medium", "high"] as const;
export type ConfidenceLevel = (typeof confidenceLevels)[number];

export const ruleCategories = [
  "input",
  "identity",
  "telegram",
  "tonconnect",
  "transaction",
  "emulation",
  "jetton",
  "wallet",
  "contract",
  "domain",
  "provider",
] as const;

export type RuleCategory = (typeof ruleCategories)[number];
export type RuleId = `${Uppercase<RuleCategory>}_${Uppercase<string>}`;

export interface RuleDefinition {
  readonly id: RuleId;
  readonly category: RuleCategory;
  readonly severity: Severity;
  readonly title: string;
  readonly description: string;
  readonly recommendation: string;
  readonly defaultScoreDelta: number;
}

export interface RiskFinding {
  readonly ruleId: RuleId;
  readonly category: RuleCategory;
  readonly severity: Severity;
  readonly title: string;
  readonly description: string;
  readonly recommendation: string;
  readonly scoreDelta: number;
  readonly confidence: ConfidenceLevel;
  readonly evidence: Readonly<Record<string, unknown>>;
}
