import { describe, expect, it } from "vitest";
import { extractApiKey } from "../src/extract-key.ts";

describe("extractApiKey", () => {
  it("extracts the key from a Bearer Authorization header", () => {
    expect(extractApiKey({ authorization: "Bearer tsk_abc123" })).toBe("tsk_abc123");
  });

  it("is case-insensitive on the Bearer scheme", () => {
    expect(extractApiKey({ authorization: "bearer tsk_xyz" })).toBe("tsk_xyz");
    expect(extractApiKey({ authorization: "BEARER tsk_xyz" })).toBe("tsk_xyz");
  });

  it("trims surrounding whitespace on the Authorization header", () => {
    expect(extractApiKey({ authorization: "   Bearer   tsk_token   " })).toBe("tsk_token");
  });

  it("falls back to X-API-Key when Authorization is absent", () => {
    expect(extractApiKey({ apiKey: "tsk_xyz" })).toBe("tsk_xyz");
  });

  it("trims X-API-Key whitespace", () => {
    expect(extractApiKey({ apiKey: "  tsk_padded  " })).toBe("tsk_padded");
  });

  it("does not fall back to X-API-Key when Authorization is present but malformed", () => {
    // Caller chose Authorization-based auth; honour their choice rather than
    // letting a broken header silently bypass to a different scheme.
    expect(
      extractApiKey({
        authorization: "Basic dGVzdA==",
        apiKey: "tsk_fallback",
      }),
    ).toBeNull();
  });

  it("returns null when both headers are absent", () => {
    expect(extractApiKey({})).toBeNull();
  });

  it("returns null for empty Authorization and empty X-API-Key", () => {
    expect(extractApiKey({ authorization: "", apiKey: "" })).toBeNull();
    expect(extractApiKey({ authorization: "   ", apiKey: "   " })).toBeNull();
  });

  it("returns null when Authorization is just 'Bearer ' with no key", () => {
    expect(extractApiKey({ authorization: "Bearer " })).toBeNull();
    expect(extractApiKey({ authorization: "Bearer" })).toBeNull();
  });
});
