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

  it("flags a manifest hosted off the declared app's registrable domain (no redirect) as EXTERNAL_HOST low", () => {
    // Was previously `TONCONNECT_MANIFEST_ORIGIN_MISMATCH` (high). The SDK
    // allows hosting the manifest on any host; without a cross-origin
    // redirect, this is the lower-severity "external host" signal.
    const manifestUrl = new URL("https://example.com/tonconnect-manifest.json");
    const manifest = buildManifest({ url: new URL("https://other.example") });

    const findings = scanManifestIdentity(manifestUrl, manifestUrl, manifest);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("TONCONNECT_MANIFEST_EXTERNAL_HOST");
    expect(findings[0]?.evidence).toMatchObject({
      declaredAppOrigin: "https://other.example",
      declaredRegistrableDomain: "other.example",
      finalRegistrableDomain: "example.com",
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

// ── registrable-domain origin policy ─────────────────────────────────────────

describe("scanManifestIdentity registrable-domain policy", () => {
  it("does NOT flag DeDust (manifest on app.dedust.io claiming dedust.io)", () => {
    // Real-world case from production smoke tests. Same registrable domain
    // (dedust.io) — common SPA pattern where the wallet-connecting code lives
    // on `app.X` and the marketing site is at the apex.
    const manifestUrl = new URL("https://app.dedust.io/tonconnect-manifest.json");
    const manifest = buildManifest({ url: new URL("https://dedust.io") });

    const findings = scanManifestIdentity(manifestUrl, manifestUrl, manifest);

    expect(findings.some((f) => f.ruleId === "TONCONNECT_MANIFEST_ORIGIN_MISMATCH")).toBe(false);
    expect(findings.some((f) => f.ruleId === "TONCONNECT_MANIFEST_EXTERNAL_HOST")).toBe(false);
  });

  it("treats www and apex as same registrable domain", () => {
    const manifestUrl = new URL("https://www.example.com/tonconnect-manifest.json");
    const manifest = buildManifest({ url: new URL("https://example.com") });

    const findings = scanManifestIdentity(manifestUrl, manifestUrl, manifest);

    expect(findings).toEqual([]);
  });

  it("treats app.example.co.uk and example.co.uk as same registrable domain (multi-part TLD)", () => {
    const manifestUrl = new URL("https://app.example.co.uk/tonconnect-manifest.json");
    const manifest = buildManifest({ url: new URL("https://example.co.uk") });

    const findings = scanManifestIdentity(manifestUrl, manifestUrl, manifest);

    expect(findings).toEqual([]);
  });

  it("emits EXTERNAL_HOST (low) for a manifest on a CDN-style host with no redirect", () => {
    const manifestUrl = new URL("https://manifests.cloud-cdn.example/tonconnect-manifest.json");
    const manifest = buildManifest({ url: new URL("https://realapp.example") });

    const findings = scanManifestIdentity(manifestUrl, manifestUrl, manifest);

    const external = findings.find((f) => f.ruleId === "TONCONNECT_MANIFEST_EXTERNAL_HOST");
    const high = findings.find((f) => f.ruleId === "TONCONNECT_MANIFEST_ORIGIN_MISMATCH");

    expect(external).toBeDefined();
    expect(high).toBeUndefined();
    expect(external?.severity).toBe("low");
  });

  it("emits high ORIGIN_MISMATCH on cross-registrable-domain redirect to attacker", () => {
    // Input is on the legit app's registrable domain. Server redirects to a
    // foreign RD. Manifest claims the legit app. This is the redirect-attack
    // shape — security regression test for PR #2.
    const manifestUrl = new URL("https://realapp.example/tonconnect-manifest.json");
    const finalUrl = new URL("https://attacker.different/tonconnect-manifest.json");
    const manifest = buildManifest({ url: new URL("https://realapp.example") });

    const findings = scanManifestIdentity(manifestUrl, finalUrl, manifest);

    const high = findings.find((f) => f.ruleId === "TONCONNECT_MANIFEST_ORIGIN_MISMATCH");

    expect(high).toBeDefined();
    expect(high?.evidence).toMatchObject({
      followedCrossOriginRedirect: true,
      finalRegistrableDomain: "attacker.different",
      declaredRegistrableDomain: "realapp.example",
    });
  });

  it("does not emit EXTERNAL_HOST when there's also a high mismatch (no double-flagging)", () => {
    const manifestUrl = new URL("https://realapp.example/tonconnect-manifest.json");
    const finalUrl = new URL("https://attacker.different/tonconnect-manifest.json");
    const manifest = buildManifest({ url: new URL("https://realapp.example") });

    const findings = scanManifestIdentity(manifestUrl, finalUrl, manifest);

    expect(findings.some((f) => f.ruleId === "TONCONNECT_MANIFEST_EXTERNAL_HOST")).toBe(false);
  });

  it("falls back to high ORIGIN_MISMATCH when registrable domain is unparseable (raw IP host)", () => {
    // Defensive: if tldts can't extract a registrable domain (e.g. raw IPs,
    // single-label hosts), treat it as a hard mismatch rather than silently
    // allowing it.
    const manifestUrl = new URL("https://192.0.2.1/tonconnect-manifest.json");
    const manifest = buildManifest({ url: new URL("https://realapp.example") });

    const findings = scanManifestIdentity(manifestUrl, manifestUrl, manifest);

    expect(findings.some((f) => f.ruleId === "TONCONNECT_MANIFEST_ORIGIN_MISMATCH")).toBe(true);
  });
});
