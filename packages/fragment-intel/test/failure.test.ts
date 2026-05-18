import { describe, expect, it } from "vitest";
import { classifyTonApiFailure } from "../src/failure.ts";

describe("classifyTonApiFailure", () => {
  it("returns provider_down with httpStatus=null for non-object errors", () => {
    expect(classifyTonApiFailure(new Error("network reset"))).toMatchObject({
      status: "provider_down",
      httpStatus: null,
    });
  });

  it("returns not_found for HTTP 404 errors", () => {
    const result = classifyTonApiFailure({ status: 404, message: "domain not found" });
    expect(result.status).toBe("not_found");
    if (result.status !== "not_found") return;
    expect(result.description).toBe("domain not found");
  });

  it("returns rate_limited for HTTP 429", () => {
    expect(classifyTonApiFailure({ status: 429 })).toEqual({
      status: "rate_limited",
      httpStatus: 429,
    });
  });

  it("returns provider_down for 5xx", () => {
    expect(classifyTonApiFailure({ status: 503 })).toEqual({
      status: "provider_down",
      httpStatus: 503,
    });
  });

  it("returns failed for 4xx non-429 / non-404", () => {
    expect(classifyTonApiFailure({ status: 400 })).toEqual({
      status: "failed",
      httpStatus: 400,
    });
  });

  it("falls back to not_found_description when message is missing", () => {
    const result = classifyTonApiFailure({ status: 404 });
    if (result.status !== "not_found") throw new Error("expected not_found");
    expect(result.description).toBe("tonapi_not_found");
  });
});
