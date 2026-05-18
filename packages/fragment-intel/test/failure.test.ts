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

  // Smoke-test regression: `@ton-api/client@0.4` throws
  // `new Error(message, { cause: response })` rather than a plain
  // `{ status }` object. Pre-fix, every Telegram handle scan emitted a
  // spurious `TELEGRAM_FRAGMENT_API_UNAVAILABLE` because the status
  // was on `error.cause.status`, not `error.status`.
  it("reads the HTTP status from `error.cause.status` (SDK wrapping)", () => {
    const sdkError = new Error("entity not found", { cause: { status: 404 } });
    const result = classifyTonApiFailure(sdkError);
    expect(result.status).toBe("not_found");
  });

  it("classifies SDK-wrapped 429 as rate_limited", () => {
    const sdkError = new Error("rate limit", { cause: { status: 429 } });
    expect(classifyTonApiFailure(sdkError)).toEqual({
      status: "rate_limited",
      httpStatus: 429,
    });
  });

  it("classifies SDK-wrapped 5xx as provider_down", () => {
    const sdkError = new Error("server crashed", { cause: { status: 502 } });
    expect(classifyTonApiFailure(sdkError)).toEqual({
      status: "provider_down",
      httpStatus: 502,
    });
  });

  it("still treats a plain Error with no cause as provider_down (network drop)", () => {
    expect(classifyTonApiFailure(new Error("ECONNRESET"))).toEqual({
      status: "provider_down",
      httpStatus: null,
    });
  });
});
