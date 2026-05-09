import { describe, expect, it } from "vitest";
import { resolveRequestId } from "../src/request-id.ts";

describe("resolveRequestId", () => {
  it("generates a UUID when no upstream id is provided", () => {
    const id = resolveRequestId();

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("preserves a non-empty upstream id", () => {
    expect(resolveRequestId("upstream-trace-abc")).toBe("upstream-trace-abc");
  });

  it("trims surrounding whitespace from upstream ids", () => {
    expect(resolveRequestId("   trace-id  ")).toBe("trace-id");
  });

  it("falls back to a UUID when the upstream id is empty or whitespace only", () => {
    expect(resolveRequestId("")).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId("   ")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("falls back to a UUID when the upstream id exceeds the size cap", () => {
    const huge = "x".repeat(257);

    expect(resolveRequestId(huge)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("accepts an id at the size cap boundary", () => {
    const maxSize = "x".repeat(256);

    expect(resolveRequestId(maxSize)).toBe(maxSize);
  });

  it("falls back to a UUID when the upstream id contains unsafe header characters", () => {
    expect(resolveRequestId("trace\ninjected")).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId("trace with spaces")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("treats null the same as undefined", () => {
    expect(resolveRequestId(null)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
