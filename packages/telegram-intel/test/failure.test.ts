import { describe, expect, it } from "vitest";
import { classifyBotApiFailure } from "../src/failure.ts";

// Mimics the shape of grammY's `GrammyError` and the raw Bot API error
// envelope. The classifier reads the same fields off either, so a structural
// fixture is sufficient.
const botApiError = (overrides: {
  error_code?: number;
  description?: string;
  parameters?: Record<string, unknown>;
}): Readonly<Record<string, unknown>> => ({
  ok: false,
  error_code: overrides.error_code ?? 400,
  description: overrides.description ?? "",
  ...(overrides.parameters === undefined ? {} : { parameters: overrides.parameters }),
});

describe("classifyBotApiFailure", () => {
  it("classifies 429 as rate_limited and surfaces parameters.retry_after when present", () => {
    const result = classifyBotApiFailure(
      botApiError({
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 5 },
      }),
    );

    expect(result).toEqual({
      status: "rate_limited",
      httpStatus: 429,
      retryAfter: 5,
    });
  });

  it("classifies 429 with no retry_after as rate_limited with retryAfter=null", () => {
    const result = classifyBotApiFailure(
      botApiError({ error_code: 429, description: "Too Many Requests" }),
    );

    expect(result).toEqual({
      status: "rate_limited",
      httpStatus: 429,
      retryAfter: null,
    });
  });

  it("classifies 'Bad Request: chat not found' as not_resolvable, not failed", () => {
    // This is the single most important branch: a 400 with chat-not-found
    // means the scanner can offer a specific UX ("forward a message instead")
    // rather than a generic failure. PR-2 surfaces the discriminator.
    const result = classifyBotApiFailure(
      botApiError({ error_code: 400, description: "Bad Request: chat not found" }),
    );

    expect(result).toEqual({
      status: "not_resolvable",
      description: "Bad Request: chat not found",
    });
  });

  it("classifies 'Bad Request: USER_NOT_FOUND' as not_resolvable", () => {
    const result = classifyBotApiFailure(
      botApiError({ error_code: 400, description: "Bad Request: USER_NOT_FOUND" }),
    );

    expect(result.status).toBe("not_resolvable");
  });

  it("classifies 'Bad Request: USERNAME_NOT_OCCUPIED' as not_resolvable", () => {
    const result = classifyBotApiFailure(
      botApiError({ error_code: 400, description: "Bad Request: USERNAME_NOT_OCCUPIED" }),
    );

    expect(result.status).toBe("not_resolvable");
  });

  it("classifies a generic 400 (not chat-not-found) as failed, NOT not_resolvable", () => {
    const result = classifyBotApiFailure(
      botApiError({ error_code: 400, description: "Bad Request: message text is empty" }),
    );

    expect(result).toEqual({
      status: "failed",
      httpStatus: 400,
      description: "Bad Request: message text is empty",
    });
  });

  it("classifies 401 / 403 as failed", () => {
    expect(
      classifyBotApiFailure(botApiError({ error_code: 401, description: "Unauthorized" })).status,
    ).toBe("failed");
    expect(
      classifyBotApiFailure(
        botApiError({ error_code: 403, description: "Forbidden: bot was blocked by the user" }),
      ).status,
    ).toBe("failed");
  });

  it("classifies 5xx as provider_down with the actual status code", () => {
    const result = classifyBotApiFailure(
      botApiError({ error_code: 502, description: "Bad Gateway" }),
    );

    expect(result).toEqual({
      status: "provider_down",
      httpStatus: 502,
    });
  });

  it("classifies a thrown Error without error_code as provider_down with httpStatus=null", () => {
    // Network/DNS/timeout errors don't have a Bot API envelope. The
    // classifier should still gracefully bucket them as provider_down so
    // callers can emit `TELEGRAM_BOT_API_PROVIDER_DOWN` uniformly.
    const result = classifyBotApiFailure(new Error("ECONNREFUSED"));

    expect(result).toEqual({
      status: "provider_down",
      httpStatus: null,
    });
  });

  it("classifies non-error inputs (string, undefined, null) as provider_down/null", () => {
    expect(classifyBotApiFailure("oops")).toEqual({ status: "provider_down", httpStatus: null });
    expect(classifyBotApiFailure(undefined)).toEqual({ status: "provider_down", httpStatus: null });
    expect(classifyBotApiFailure(null)).toEqual({ status: "provider_down", httpStatus: null });
  });

  it("matches not-resolvable descriptions by prefix, tolerating trailing text", () => {
    // Telegram occasionally appends extra detail (e.g. ": invalid chat type")
    // to the canonical phrase. Prefix-matching is intentional so we don't
    // regress on minor wording changes.
    const result = classifyBotApiFailure(
      botApiError({
        error_code: 400,
        description: "Bad Request: chat not found: invalid chat type",
      }),
    );

    expect(result.status).toBe("not_resolvable");
  });
});
