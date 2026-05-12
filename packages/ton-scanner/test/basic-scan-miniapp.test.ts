import { afterEach, describe, expect, it, vi } from "vitest";
import { safeFetch } from "@tonshield/safe-fetch";

vi.mock("@tonshield/safe-fetch", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tonshield/safe-fetch")>();
  return { ...original, safeFetch: vi.fn() };
});

const mockedFetch = vi.mocked(safeFetch);

afterEach(() => {
  vi.clearAllMocks();
  vi.doUnmock("../src/classify-input.ts");
  vi.resetModules();
});

describe("createBasicScan — telegram_miniapp_url wiring", () => {
  it("runs the Mini App content scanner without requiring a Telegram entity store", async () => {
    const target = new URL("https://miniapp.example/launch");

    vi.doMock("../src/classify-input.ts", () => ({
      classifyInput: vi.fn(() => ({
        kind: "telegram_miniapp_url",
        raw: "tg-miniapp-context://launch",
        normalized: target.toString(),
        url: target,
        hostBot: "examplebot",
      })),
    }));

    mockedFetch.mockResolvedValue({
      ok: true,
      value: {
        body: "<html><body>Enter your seed phrase to claim your airdrop.</body></html>",
        contentType: "text/html",
        finalUrl: target,
      },
    });

    const { createBasicScan } = await import("../src/basic-scan.ts");
    const report = await createBasicScan({ rawInput: "tg-miniapp-context://launch" });

    expect(report.input.kind).toBe("telegram_miniapp_url");
    expect(report.findings.map((f) => f.ruleId)).toContain("TELEGRAM_MINIAPP_CREDENTIAL_PHISHING");
    expect(report.findings.map((f) => f.ruleId)).not.toContain(
      "TELEGRAM_INPUT_RECOGNISED_NOT_SCANNED",
    );
  });
});

describe("createBasicScan — telegram_nft_link wiring", () => {
  it("runs the gift-link scanner without requiring a Telegram entity store (PR-6 replaces PR-2 not-scanned placeholder)", async () => {
    const target = new URL("https://t.me/nft/PlushPepe-10");

    mockedFetch.mockResolvedValue({
      ok: true,
      value: {
        body: `
          <meta property="og:title" content="Plush Pepe #10" />
          <meta property="al:ios:url" content="tg://nft?slug=PlushPepe-10" />
        `,
        contentType: "text/html",
        finalUrl: target,
      },
    });

    const { createBasicScan } = await import("../src/basic-scan.ts");
    const report = await createBasicScan({ rawInput: target.toString() });

    expect(report.input.kind).toBe("telegram_nft_link");
    // Verified gift returns an ActionPreview, no finding — but also no
    // PR-2 "not scanned" placeholder.
    expect(report.findings.map((f) => f.ruleId)).not.toContain(
      "TELEGRAM_INPUT_RECOGNISED_NOT_SCANNED",
    );
    expect(report.actions.length).toBeGreaterThan(0);
    expect(report.actions[0]?.kind).toBe("send_nft");
  });

  it("emits TELEGRAM_GIFT_LINK_NOT_VERIFIED for an unresolved slug", async () => {
    const target = new URL("https://t.me/nft/Fake-12345");

    // Telegram 302s unknown slugs to the homepage.
    mockedFetch.mockResolvedValue({
      ok: true,
      value: {
        body: "<html><body>Telegram homepage</body></html>",
        contentType: "text/html",
        finalUrl: new URL("https://telegram.org/"),
      },
    });

    const { createBasicScan } = await import("../src/basic-scan.ts");
    const report = await createBasicScan({ rawInput: target.toString() });

    expect(report.findings.map((f) => f.ruleId)).toContain("TELEGRAM_GIFT_LINK_NOT_VERIFIED");
  });
});
