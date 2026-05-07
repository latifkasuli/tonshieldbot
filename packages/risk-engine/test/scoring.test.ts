import { describe, expect, it } from "vitest";
import { createFinding, coreRules, scoreFindings, verdictFromScore } from "../src/index.ts";

describe("risk scoring", () => {
  it("maps high-risk findings into a high verdict", () => {
    const finding = createFinding({
      rule: coreRules[1],
      confidence: "high",
      scoreDelta: 65,
    });

    const score = scoreFindings([finding]);

    expect(score).toBe(65);
    expect(verdictFromScore(score)).toBe("high");
  });

  it("clamps critical scores at 100", () => {
    const findings = [
      createFinding({ rule: coreRules[1], confidence: "high", scoreDelta: 80 }),
      createFinding({ rule: coreRules[3], confidence: "medium", scoreDelta: 80 }),
    ];

    expect(scoreFindings(findings)).toBe(100);
  });
});
