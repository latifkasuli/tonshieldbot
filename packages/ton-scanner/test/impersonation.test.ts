import { describe, expect, it } from "vitest";
import {
  detectDomainImpersonation,
  detectNameImpersonation,
  getRegistrableDomain,
  isOfficialHostname,
  normalizeForComparison,
} from "../src/impersonation.ts";
import { knownProjects } from "../src/data/known-projects.ts";

const tonkeeper = knownProjects.find((project) => project.id === "tonkeeper");

if (tonkeeper === undefined) {
  throw new Error("Tonkeeper fixture is missing");
}

describe("normalizeForComparison", () => {
  it("normalizes common homoglyph and typo inputs", () => {
    expect(normalizeForComparison("T0nkeeper")).toBe("tonkeeper");
    expect(normalizeForComparison("Тonkeeper")).toBe("tonkeeper");
    expect(normalizeForComparison("tоnkeeper")).toBe("tonkeeper");
    expect(normalizeForComparison("tön-keeper")).toBe("tonkeeper");
  });
});

describe("official hostname detection", () => {
  it("trusts exact official domains and their subdomains", () => {
    expect(isOfficialHostname("tonkeeper.com", tonkeeper)).toBe(true);
    expect(isOfficialHostname("app.tonkeeper.com", tonkeeper)).toBe(true);
  });

  it("does not trust same SLD on a different suffix", () => {
    expect(isOfficialHostname("tonkeeper.xyz", tonkeeper)).toBe(false);
  });

  it("uses public suffix parsing for multi-part suffixes", () => {
    expect(getRegistrableDomain("fake.tonkeeper.co.uk")).toBe("tonkeeper.co.uk");
  });
});

describe("detectDomainImpersonation", () => {
  it("ignores official domains", () => {
    expect(detectDomainImpersonation("tonkeeper.com")).toBeNull();
    expect(detectDomainImpersonation("app.tonkeeper.com")).toBeNull();
  });

  it("detects lookalike and containing domains", () => {
    expect(detectDomainImpersonation("t0nkeeper.xyz")?.project.id).toBe("tonkeeper");
    expect(detectDomainImpersonation("тonkeeper.com")?.project.id).toBe("tonkeeper");
    expect(detectDomainImpersonation("tonkeeper-app.xyz")?.matchKind).toBe("domain_contains");
    expect(detectDomainImpersonation("fragment-gifts.claim")?.project.id).toBe("fragment");
  });

  it("flags same SLD with a wrong public suffix as impersonation", () => {
    const match = detectDomainImpersonation("tonkeeper.xyz");

    expect(match?.project.id).toBe("tonkeeper");
    expect(match?.confidence).toBe("high");
  });
});

describe("detectNameImpersonation", () => {
  it("detects known project names hosted away from official domains", () => {
    expect(detectNameImpersonation("Tonkeeper", "evil.example")?.project.id).toBe("tonkeeper");
    expect(detectNameImpersonation("Тonkeeper", "evil.example")?.project.id).toBe("tonkeeper");
  });

  it("ignores known project names on official domains", () => {
    expect(detectNameImpersonation("Tonkeeper", "app.tonkeeper.com")).toBeNull();
  });
});
