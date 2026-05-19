import { describe, expect, it } from "vitest";
import { knownRiskProjects, matchKnownRiskProjectHandle } from "../src/project-risk-registry.ts";

describe("matchKnownRiskProjectHandle", () => {
  it("matches exact official handles for locally flagged high-risk projects", () => {
    expect(matchKnownRiskProjectHandle("@starshash_bot", knownRiskProjects)).toMatchObject({
      project: "StarsHash",
      risk: "operator_reported_funds_misconduct",
      severity: "high",
    });
    expect(matchKnownRiskProjectHandle("STARSHASH", knownRiskProjects)).toMatchObject({
      project: "StarsHash",
    });
  });

  it("does not fuzzy-match clone handles through the project-risk registry", () => {
    expect(matchKnownRiskProjectHandle("starhashrobot", knownRiskProjects)).toBeNull();
  });
});
