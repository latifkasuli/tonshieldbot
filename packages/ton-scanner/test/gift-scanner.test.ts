import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeFetch } from "@tonshield/safe-fetch";
import { scanGiftLink } from "../src/telegram/gift-scanner.ts";

// Boundary-mock safe-fetch. Parsing is covered by
// `@tonshield/telegram-intel`'s own tests; here we pin the scanner's
// wiring: that the right rule fires with the right reason and that the
// verified path produces an ActionPreview with no finding.
vi.mock("@tonshield/safe-fetch", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tonshield/safe-fetch")>();
  return { ...original, safeFetch: vi.fn() };
});

const mockedFetch = vi.mocked(safeFetch);

const TARGET = new URL("https://t.me/nft/PlushPepe-10");

const okResponse = (body: string, finalUrl: URL = TARGET) => ({
  ok: true as const,
  value: { body, contentType: "text/html; charset=utf-8", finalUrl },
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const VERIFIED_BODY = `
  <meta property="og:title" content="Plush Pepe #10" />
  <meta property="og:description" content="Model: Bavaria&#10;Backdrop: Turquoise&#10;Symbol: Flying Heart" />
  <meta property="og:image" content="https://cdn4.telesco.pe/file/abc.jpg" />
  <meta property="al:ios:url" content="tg://nft?slug=PlushPepe-10" />
`;

describe("scanGiftLink — verified", () => {
  it("returns no finding and an ActionPreview when the slug resolves", async () => {
    mockedFetch.mockResolvedValue(okResponse(VERIFIED_BODY));

    const result = await scanGiftLink(TARGET, "PlushPepe-10");

    expect(result.findings).toEqual([]);
    expect(result.actions).toHaveLength(1);
    const action = result.actions[0];
    expect(action?.kind).toBe("send_nft");
    expect(action?.title).toBe("Telegram gift: Plush Pepe #10");
    expect(action?.description).toBe("Model: Bavaria, Backdrop: Turquoise, Symbol: Flying Heart");
  });

  it("falls back to collectible number in the description when no attributes present", async () => {
    mockedFetch.mockResolvedValue(
      okResponse(`
        <meta property="og:title" content="Plush Pepe #10" />
        <meta property="al:ios:url" content="tg://nft?slug=PlushPepe-10" />
      `),
    );

    const result = await scanGiftLink(TARGET, "PlushPepe-10");
    expect(result.actions[0]?.description).toBe("Collectible #10");
  });
});

describe("scanGiftLink — not_verified", () => {
  it("emits TELEGRAM_GIFT_LINK_NOT_VERIFIED with high confidence when the page echoes a different slug", async () => {
    mockedFetch.mockResolvedValue(
      okResponse(VERIFIED_BODY.replace("PlushPepe-10", "PlushPepe-9999")),
    );

    const result = await scanGiftLink(TARGET, "PlushPepe-10");
    expect(result.actions).toEqual([]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe("TELEGRAM_GIFT_LINK_NOT_VERIFIED");
    expect(result.findings[0]?.confidence).toBe("high");
    expect(result.findings[0]?.evidence).toMatchObject({
      slug: "PlushPepe-10",
      reason: "slug_marker_mismatch",
    });
  });

  it("emits TELEGRAM_GIFT_LINK_NOT_VERIFIED with medium confidence when al:ios:url is missing", async () => {
    mockedFetch.mockResolvedValue(okResponse(`<meta property="og:title" content="something" />`));

    const result = await scanGiftLink(TARGET, "PlushPepe-10");
    expect(result.findings[0]?.ruleId).toBe("TELEGRAM_GIFT_LINK_NOT_VERIFIED");
    expect(result.findings[0]?.confidence).toBe("medium");
    expect(result.findings[0]?.evidence).toMatchObject({
      reason: "slug_marker_missing",
    });
  });

  it("emits TELEGRAM_GIFT_LINK_NOT_VERIFIED when redirected off the /nft/<slug> path", async () => {
    // Telegram 302s unknown slugs to its homepage.
    mockedFetch.mockResolvedValue(
      okResponse("<html><body>Telegram homepage</body></html>", new URL("https://telegram.org/")),
    );

    const result = await scanGiftLink(TARGET, "PlushPepe-10");
    expect(result.findings[0]?.ruleId).toBe("TELEGRAM_GIFT_LINK_NOT_VERIFIED");
    expect(result.findings[0]?.confidence).toBe("high");
    expect(result.findings[0]?.evidence).toMatchObject({
      slug: "PlushPepe-10",
      reason: "redirected_off_path",
      finalUrl: "https://telegram.org/",
    });
  });

  it("does not over-trigger redirected_off_path when the final URL is the canonical /nft/<slug>", async () => {
    // Some redirects normalise case but stay on the gift path.
    mockedFetch.mockResolvedValue(
      okResponse(VERIFIED_BODY, new URL("https://t.me/nft/PlushPepe-10/")),
    );

    const result = await scanGiftLink(TARGET, "PlushPepe-10");
    expect(result.findings).toEqual([]);
  });
});

describe("scanGiftLink — fetch failure", () => {
  it("emits TELEGRAM_GIFT_LINK_NOT_VERIFIED with reason=non_gift_page on fetch failure", async () => {
    mockedFetch.mockResolvedValue({ ok: false, error: "fetch_failed" });

    const result = await scanGiftLink(TARGET, "PlushPepe-10");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe("TELEGRAM_GIFT_LINK_NOT_VERIFIED");
    expect(result.findings[0]?.evidence).toMatchObject({
      slug: "PlushPepe-10",
      reason: "non_gift_page",
      fetchError: "fetch_failed",
    });
  });

  it("emits TELEGRAM_GIFT_LINK_NOT_VERIFIED on SSRF block (user submitted internal URL)", async () => {
    mockedFetch.mockResolvedValue({ ok: false, error: "ssrf_blocked" });

    const result = await scanGiftLink(TARGET, "PlushPepe-10");
    expect(result.findings[0]?.evidence).toMatchObject({ fetchError: "ssrf_blocked" });
  });
});
