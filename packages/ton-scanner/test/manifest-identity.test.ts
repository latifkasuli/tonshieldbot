import { describe, expect, it } from "vitest";
import { scanManifestIdentity } from "../src/manifest-identity.ts";
import type { TonConnectManifest } from "../src/manifest.ts";

const buildManifest = (overrides: Partial<TonConnectManifest> = {}): TonConnectManifest => ({
  url: new URL("https://example.com"),
  name: "Example",
  iconUrl: new URL("https://example.com/icon.png"),
  termsOfUseUrl: null,
  privacyPolicyUrl: null,
  ...overrides,
});

describe("scanManifestIdentity", () => {
  it("returns no findings when input, served, and declared origins all agree", () => {
    const manifestUrl = new URL("https://example.com/tonconnect-manifest.json");
    const findings = scanManifestIdentity(manifestUrl, manifestUrl, buildManifest());

    expect(findings).toEqual([]);
  });

  it("flags a same-origin manifest that declares a different app origin", () => {
    const manifestUrl = new URL("https://example.com/tonconnect-manifest.json");
    const manifest = buildManifest({ url: new URL("https://other.example") });

    const findings = scanManifestIdentity(manifestUrl, manifestUrl, manifest);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("TONCONNECT_MANIFEST_ORIGIN_MISMATCH");
    expect(findings[0]?.evidence).toMatchObject({
      declaredAppOrigin: "https://other.example",
      followedCrossOriginRedirect: false,
      inputOrigin: "https://example.com",
      manifestOrigin: "https://example.com",
    });
  });

  it("uses finalUrl (not input) for the origin-mismatch check when redirect crossed origins", () => {
    // Bug being fixed: a manifest that 301s from `legit.com` to `attacker.com` and then
    // claims `url: https://legit.com` would have passed the old check (input.origin ===
    // declared.origin) even though the file was served by attacker.com.
    const manifestUrl = new URL("https://legit.com/tonconnect-manifest.json");
    const finalUrl = new URL("https://attacker.example/tonconnect-manifest.json");
    const manifest = buildManifest({ url: new URL("https://legit.com") });

    const findings = scanManifestIdentity(manifestUrl, finalUrl, manifest);

    expect(findings.some((f) => f.ruleId === "TONCONNECT_MANIFEST_ORIGIN_MISMATCH")).toBe(true);

    const mismatch = findings.find((f) => f.ruleId === "TONCONNECT_MANIFEST_ORIGIN_MISMATCH");

    expect(mismatch?.evidence).toMatchObject({
      declaredAppOrigin: "https://legit.com",
      followedCrossOriginRedirect: true,
      inputOrigin: "https://legit.com",
      manifestOrigin: "https://attacker.example",
    });
  });

  it("does not double-flag origin mismatch when the manifest agrees with the redirect target", () => {
    // Cross-origin redirect, manifest self-consistent at the final URL.
    // The mismatch check should not fire (final origin === declared origin),
    // but evidence in any future redirect-only finding should still note the redirect.
    const manifestUrl = new URL("https://cdn.example/manifest.json");
    const finalUrl = new URL("https://app.example/manifest.json");
    const manifest = buildManifest({ url: new URL("https://app.example") });

    const findings = scanManifestIdentity(manifestUrl, finalUrl, manifest);

    expect(findings.filter((f) => f.ruleId === "TONCONNECT_MANIFEST_ORIGIN_MISMATCH")).toHaveLength(
      0,
    );
  });

  it("detects domain impersonation against the final URL hostname after a redirect", () => {
    const manifestUrl = new URL("https://harmless-link.example/m.json");
    const finalUrl = new URL("https://t0nkeeper.xyz/m.json");
    const manifest = buildManifest({ url: new URL("https://harmless-link.example") });

    const findings = scanManifestIdentity(manifestUrl, finalUrl, manifest);

    const impersonation = findings.find((f) => f.ruleId === "TONCONNECT_PROJECT_IMPERSONATION");

    expect(impersonation).toBeDefined();
    expect(impersonation?.evidence).toMatchObject({
      hostname: "t0nkeeper.xyz",
      source: "final_url",
      suspectedProject: "Tonkeeper",
    });
  });

  it("dedupes impersonation candidates so identical hostnames do not double-fire", () => {
    const manifestUrl = new URL("https://t0nkeeper.xyz/m.json");
    const finalUrl = manifestUrl;
    const manifest = buildManifest({ url: new URL("https://t0nkeeper.xyz") });

    const findings = scanManifestIdentity(manifestUrl, finalUrl, manifest);

    const impersonations = findings.filter((f) => f.ruleId === "TONCONNECT_PROJECT_IMPERSONATION");

    expect(impersonations).toHaveLength(1);
  });

  it("checks name impersonation against the served hostname, not the input hostname", () => {
    // User pastes a clean URL that redirects to attacker.com, which serves a manifest
    // claiming the name "Tonkeeper". The clean input hostname must not suppress the
    // name-impersonation finding.
    const manifestUrl = new URL("https://safe-link.example/m.json");
    const finalUrl = new URL("https://attacker.example/m.json");
    const manifest = buildManifest({
      name: "Tonkeeper",
      url: new URL("https://attacker.example"),
    });

    const findings = scanManifestIdentity(manifestUrl, finalUrl, manifest);

    const nameMatch = findings.find(
      (f) =>
        f.ruleId === "TONCONNECT_PROJECT_IMPERSONATION" && f.evidence.claimedName === "Tonkeeper",
    );

    expect(nameMatch).toBeDefined();
    expect(nameMatch?.evidence.hostingDomain).toBe("attacker.example");
  });
});
