import { describe, expect, it } from "vitest";
import { defaultTierLimits } from "../src/tiers.ts";

describe("defaultTierLimits", () => {
  it("provides a non-zero limit for every tier", () => {
    for (const [name, limit] of Object.entries(defaultTierLimits)) {
      expect(limit.bucketSize, name).toBeGreaterThan(0);
      expect(limit.refillPerSecond, name).toBeGreaterThan(0);
    }
  });

  it("orders tiers monotonically from free to internal", () => {
    expect(defaultTierLimits.free.refillPerSecond).toBeLessThan(
      defaultTierLimits.partner.refillPerSecond,
    );
    expect(defaultTierLimits.partner.refillPerSecond).toBeLessThan(
      defaultTierLimits.internal.refillPerSecond,
    );

    expect(defaultTierLimits.free.bucketSize).toBeLessThanOrEqual(
      defaultTierLimits.partner.bucketSize,
    );
    expect(defaultTierLimits.partner.bucketSize).toBeLessThanOrEqual(
      defaultTierLimits.internal.bucketSize,
    );
  });
});
