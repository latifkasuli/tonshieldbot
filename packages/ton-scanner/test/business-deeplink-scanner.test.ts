import { describe, expect, it } from "vitest";
import { scanBusinessDeeplink } from "../src/telegram/business-deeplink-scanner.ts";

describe("scanBusinessDeeplink — dangerous rights", () => {
  it("fires TELEGRAM_BUSINESS_DEEPLINK_DANGEROUS_RIGHTS when can_transfer_stars is requested", () => {
    const result = scanBusinessDeeplink({
      target: "scambot",
      rawRights: "rs", // reply + transfer_stars
      action: "addBusinessBot",
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe("TELEGRAM_BUSINESS_DEEPLINK_DANGEROUS_RIGHTS");
    expect(result.findings[0]?.confidence).toBe("high");
    expect(result.findings[0]?.evidence).toMatchObject({
      action: "addBusinessBot",
      target: "scambot",
      recognisedCount: 2,
      rawRights: "rs",
    });
    expect(result.findings[0]?.evidence.recognisedRights).toEqual([
      "can_reply",
      "can_transfer_stars",
    ]);
  });

  it("fires on can_transfer_and_upgrade_gifts (field-name form)", () => {
    const result = scanBusinessDeeplink({
      target: "scambot",
      rawRights: "can_transfer_and_upgrade_gifts",
      action: "addBusinessBot",
    });
    expect(result.findings[0]?.ruleId).toBe("TELEGRAM_BUSINESS_DEEPLINK_DANGEROUS_RIGHTS");
  });

  it("fires on can_edit_username", () => {
    const result = scanBusinessDeeplink({
      target: "scambot",
      rawRights: "u",
      action: "addBusinessBot",
    });
    expect(result.findings[0]?.ruleId).toBe("TELEGRAM_BUSINESS_DEEPLINK_DANGEROUS_RIGHTS");
  });

  it("fires on can_manage_stories (capital S)", () => {
    const result = scanBusinessDeeplink({
      target: "scambot",
      rawRights: "S",
      action: "addBusinessBot",
    });
    expect(result.findings[0]?.ruleId).toBe("TELEGRAM_BUSINESS_DEEPLINK_DANGEROUS_RIGHTS");
  });
});

describe("scanBusinessDeeplink — broad-rights (non-dangerous)", () => {
  it("fires TELEGRAM_BUSINESS_DEEPLINK_BROAD_RIGHTS when ≥3 non-dangerous rights are requested", () => {
    // r, m, n, b = reply, read, edit_name, edit_bio (none dangerous)
    const result = scanBusinessDeeplink({
      target: "marketingbot",
      rawRights: "rmnb",
      action: "addBusinessBot",
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe("TELEGRAM_BUSINESS_DEEPLINK_BROAD_RIGHTS");
    expect(result.findings[0]?.confidence).toBe("medium");
    expect(result.findings[0]?.evidence.recognisedCount).toBe(4);
  });

  it("does NOT fire below the broad-rights threshold", () => {
    const result = scanBusinessDeeplink({
      target: "marketingbot",
      rawRights: "rm", // only 2 rights, both benign
      action: "addBusinessBot",
    });
    expect(result.findings).toEqual([]);
  });

  it("prefers DANGEROUS over BROAD when both conditions could apply", () => {
    // 4 rights total, one of which (s) is dangerous.
    const result = scanBusinessDeeplink({
      target: "scambot",
      rawRights: "rmns",
      action: "addBusinessBot",
    });
    expect(result.findings[0]?.ruleId).toBe("TELEGRAM_BUSINESS_DEEPLINK_DANGEROUS_RIGHTS");
  });
});

describe("scanBusinessDeeplink — no rights payload", () => {
  it("returns no findings when rawRights is null", () => {
    const result = scanBusinessDeeplink({
      target: "somebot",
      rawRights: null,
      action: "startbusiness",
    });
    expect(result.findings).toEqual([]);
  });

  it("returns no findings when rawRights is empty", () => {
    const result = scanBusinessDeeplink({
      target: "somebot",
      rawRights: "",
      action: "addBusinessBot",
    });
    expect(result.findings).toEqual([]);
  });
});

describe("scanBusinessDeeplink — evidence shape", () => {
  it("preserves unknown tokens for operator audit", () => {
    const result = scanBusinessDeeplink({
      target: "scambot",
      rawRights: "sXY",
      action: "addBusinessBot",
    });
    expect(result.findings[0]?.evidence.unknownTokens).toEqual(expect.arrayContaining(["X", "Y"]));
  });

  it("omits the `target` field when not provided", () => {
    const result = scanBusinessDeeplink({
      target: null,
      rawRights: "s",
      action: "addBusinessBot",
    });
    expect(result.findings[0]?.evidence).not.toHaveProperty("target");
  });

  it("omits unknownTokens when there are none", () => {
    const result = scanBusinessDeeplink({
      target: "scambot",
      rawRights: "s",
      action: "addBusinessBot",
    });
    expect(result.findings[0]?.evidence).not.toHaveProperty("unknownTokens");
  });
});
