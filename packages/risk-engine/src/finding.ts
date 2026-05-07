import type { ConfidenceLevel, RiskFinding, RuleDefinition } from "@tonshield/shared";

export interface CreateFindingInput {
  readonly rule: RuleDefinition;
  readonly confidence: ConfidenceLevel;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly scoreDelta?: number;
}

export const createFinding = (input: CreateFindingInput): RiskFinding => ({
  ruleId: input.rule.id,
  category: input.rule.category,
  severity: input.rule.severity,
  title: input.rule.title,
  description: input.rule.description,
  recommendation: input.rule.recommendation,
  scoreDelta: input.scoreDelta ?? input.rule.defaultScoreDelta,
  confidence: input.confidence,
  evidence: input.evidence ?? {},
});
