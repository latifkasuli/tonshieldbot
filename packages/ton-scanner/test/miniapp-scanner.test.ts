import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeFetch } from "@tonshield/safe-fetch";
import { scanMiniAppContent } from "../src/telegram/miniapp-scanner.ts";

// Boundary-mock safe-fetch. The HTTP layer's contract is covered by its
// own package's tests; here we pin the content-scanner's wiring: that it
// classifies the response body correctly and emits the right rules with
// the right evidence shape.
vi.mock("@tonshield/safe-fetch", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tonshield/safe-fetch")>();
  return { ...original, safeFetch: vi.fn() };
});

const mockedFetch = vi.mocked(safeFetch);

const TARGET = new URL("https://example.com/miniapp");

const okResponse = (body: string) => ({
  ok: true as const,
  value: { body, contentType: "text/html; charset=utf-8", finalUrl: TARGET },
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ruleIds = (findings: readonly { ruleId: string }[]): readonly string[] =>
  findings.map((f) => f.ruleId);

// ── credential phishing ───────────────────────────────────────────────────

describe("scanMiniAppContent — credential phishing", () => {
  it("emits TELEGRAM_MINIAPP_CREDENTIAL_PHISHING when a seed-phrase prompt is detected", async () => {
    mockedFetch.mockResolvedValue(
      okResponse(
        "<html><body><h1>Restore Wallet</h1><input placeholder='Enter your 12 word seed phrase'/></body></html>",
      ),
    );

    const result = await scanMiniAppContent(TARGET);

    expect(ruleIds(result.findings)).toContain("TELEGRAM_MINIAPP_CREDENTIAL_PHISHING");
    const finding = result.findings.find(
      (f) => f.ruleId === "TELEGRAM_MINIAPP_CREDENTIAL_PHISHING",
    );
    expect(finding?.evidence).toMatchObject({
      url: TARGET.toString(),
      languagesSeen: ["en"],
    });
    expect(Array.isArray(finding?.evidence.matches)).toBe(true);
  });

  it("fires on Russian (сид-фраза) page bodies", async () => {
    mockedFetch.mockResolvedValue(
      okResponse("<html><body>Введите вашу сид-фразу из 12 слов</body></html>"),
    );

    const result = await scanMiniAppContent(TARGET);

    expect(ruleIds(result.findings)).toContain("TELEGRAM_MINIAPP_CREDENTIAL_PHISHING");
  });
});

// ── APK detection ─────────────────────────────────────────────────────────

describe("scanMiniAppContent — APK detection", () => {
  it("emits TELEGRAM_MINIAPP_APK_DOWNLOAD when an .apk link is present", async () => {
    mockedFetch.mockResolvedValue(
      okResponse(
        '<html><body><a href="https://malware.example.com/NVIDIA_App.apk">Download</a></body></html>',
      ),
    );

    const result = await scanMiniAppContent(TARGET);

    expect(ruleIds(result.findings)).toContain("TELEGRAM_MINIAPP_APK_DOWNLOAD");
    const finding = result.findings.find((f) => f.ruleId === "TELEGRAM_MINIAPP_APK_DOWNLOAD");
    expect(finding?.evidence).toMatchObject({
      apkCount: 1,
    });
    expect(finding?.evidence.apkLinks).toEqual([
      { href: "https://malware.example.com/NVIDIA_App.apk", filename: "NVIDIA_App.apk" },
    ]);
  });
});

// ── lure language ─────────────────────────────────────────────────────────

describe("scanMiniAppContent — lure language", () => {
  it("emits TELEGRAM_MINIAPP_LURE_LANGUAGE for airdrop / gift / urgency lures", async () => {
    mockedFetch.mockResolvedValue(
      okResponse(
        "<html><body>Claim your airdrop now! Limited time offer — only today.</body></html>",
      ),
    );

    const result = await scanMiniAppContent(TARGET);
    expect(ruleIds(result.findings)).toContain("TELEGRAM_MINIAPP_LURE_LANGUAGE");
  });

  it("upgrades lure-language confidence to 'high' when paired with credential phishing on the same page", async () => {
    mockedFetch.mockResolvedValue(
      okResponse("<html><body>Claim your airdrop! Enter your seed phrase to unlock.</body></html>"),
    );

    const result = await scanMiniAppContent(TARGET);
    const lure = result.findings.find((f) => f.ruleId === "TELEGRAM_MINIAPP_LURE_LANGUAGE");
    const cred = result.findings.find((f) => f.ruleId === "TELEGRAM_MINIAPP_CREDENTIAL_PHISHING");
    expect(lure?.confidence).toBe("high");
    expect(cred?.confidence).toBe("high");
  });
});

// ── full FEMITBOT-pattern fixture ─────────────────────────────────────────

describe("scanMiniAppContent — composite phishing page", () => {
  it("fires all three rules on a FEMITBOT-shaped page (lure + creds + APK)", async () => {
    mockedFetch.mockResolvedValue(
      okResponse(`
        <html>
          <body>
            <h1>Claim Your Free Telegram Premium</h1>
            <p>Limited time offer! Verify your wallet to claim.</p>
            <p>Enter your seed phrase to continue:</p>
            <input type="text" placeholder="12 word recovery phrase" />
            <a href="https://femitbot-cdn.example.com/install.apk">Download Android App</a>
          </body>
        </html>
      `),
    );

    const result = await scanMiniAppContent(TARGET);
    const ids = ruleIds(result.findings);
    expect(ids).toContain("TELEGRAM_MINIAPP_CREDENTIAL_PHISHING");
    expect(ids).toContain("TELEGRAM_MINIAPP_APK_DOWNLOAD");
    expect(ids).toContain("TELEGRAM_MINIAPP_LURE_LANGUAGE");
  });
});

// ── clean pages ───────────────────────────────────────────────────────────

describe("scanMiniAppContent — clean / legitimate pages", () => {
  it("produces no findings on a benign Mini App", async () => {
    mockedFetch.mockResolvedValue(
      okResponse("<html><body><h1>My Mini App</h1><p>Click to play.</p></body></html>"),
    );

    const result = await scanMiniAppContent(TARGET);
    expect(result.findings).toEqual([]);
    expect(result.report).not.toBeNull();
  });
});

// ── fetch failure degradation ────────────────────────────────────────────

describe("scanMiniAppContent — fetch failures", () => {
  it("returns empty findings on safe-fetch failure (silent degradation)", async () => {
    mockedFetch.mockResolvedValue({ ok: false, error: "fetch_failed" });

    const result = await scanMiniAppContent(TARGET);
    expect(result.findings).toEqual([]);
    expect(result.report).toBeNull();
  });

  it("returns empty findings on SSRF block", async () => {
    mockedFetch.mockResolvedValue({ ok: false, error: "ssrf_blocked" });

    const result = await scanMiniAppContent(TARGET);
    expect(result.findings).toEqual([]);
  });

  it("returns empty findings on timeout", async () => {
    mockedFetch.mockResolvedValue({ ok: false, error: "fetch_timeout" });

    const result = await scanMiniAppContent(TARGET);
    expect(result.findings).toEqual([]);
  });
});

// ── gift-upgrade TON address co-occurrence ────────────────────────────────

describe("scanMiniAppContent — gift-upgrade TON address co-occurrence", () => {
  it("fires TELEGRAM_GIFT_TON_ADDRESS_FOR_UPGRADE when gift_upgrade_lure + TON address co-occur", async () => {
    mockedFetch.mockResolvedValue(
      okResponse(
        `<html><body>
          <p>Upgrade your gift! Send 0.5 TON to upgrade your collectible.</p>
          <p>Address: EQAvlWFDxGF2lXm67y4yzC3scvrcnxX_QvW7YDcGFXQ8ZACU</p>
        </body></html>`,
      ),
    );

    const result = await scanMiniAppContent(TARGET);
    const ids = ruleIds(result.findings);
    expect(ids).toContain("TELEGRAM_GIFT_TON_ADDRESS_FOR_UPGRADE");
    const finding = result.findings.find(
      (f) => f.ruleId === "TELEGRAM_GIFT_TON_ADDRESS_FOR_UPGRADE",
    );
    expect(finding?.confidence).toBe("high");
    expect(finding?.evidence).toMatchObject({
      url: TARGET.toString(),
    });
    expect(finding?.evidence.tonAddresses).toEqual([
      {
        address: "EQAvlWFDxGF2lXm67y4yzC3scvrcnxX_QvW7YDcGFXQ8ZACU",
        form: "friendly",
      },
    ]);
  });

  it("does NOT fire when only gift_upgrade lure is present without a TON address", async () => {
    mockedFetch.mockResolvedValue(okResponse("<html><body>Upgrade your gift today!</body></html>"));

    const result = await scanMiniAppContent(TARGET);
    expect(ruleIds(result.findings)).not.toContain("TELEGRAM_GIFT_TON_ADDRESS_FOR_UPGRADE");
  });

  it("does NOT fire when only a TON address is present without gift_upgrade lure", async () => {
    mockedFetch.mockResolvedValue(
      okResponse("<p>Donate: EQAvlWFDxGF2lXm67y4yzC3scvrcnxX_QvW7YDcGFXQ8ZACU</p>"),
    );

    const result = await scanMiniAppContent(TARGET);
    expect(ruleIds(result.findings)).not.toContain("TELEGRAM_GIFT_TON_ADDRESS_FOR_UPGRADE");
  });
});

// ── PR-32 Stars rules ────────────────────────────────────────────────────

describe("scanMiniAppContent — Stars off-protocol TON demand", () => {
  it("fires TELEGRAM_STARS_OFF_PROTOCOL_TON_DEMAND on `buy stars with ton` phrasing", async () => {
    mockedFetch.mockResolvedValue(
      okResponse("<html><body>Buy Telegram Stars with TON. Best rate!</body></html>"),
    );

    const result = await scanMiniAppContent(TARGET);
    const ids = ruleIds(result.findings);
    expect(ids).toContain("TELEGRAM_STARS_OFF_PROTOCOL_TON_DEMAND");
    const finding = result.findings.find(
      (f) => f.ruleId === "TELEGRAM_STARS_OFF_PROTOCOL_TON_DEMAND",
    );
    expect(finding?.confidence).toBe("high");
    expect(finding?.evidence.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: "stars_off_protocol_lure" })]),
    );
  });

  it("does NOT require a TON address on the page (phrase itself is the signal)", async () => {
    mockedFetch.mockResolvedValue(
      okResponse("<html><body>Send TON to get Stars right now.</body></html>"),
    );

    const result = await scanMiniAppContent(TARGET);
    expect(ruleIds(result.findings)).toContain("TELEGRAM_STARS_OFF_PROTOCOL_TON_DEMAND");
  });

  it("includes any TON addresses found on the page in evidence", async () => {
    mockedFetch.mockResolvedValue(
      okResponse(
        "<html><body>Buy Stars with TON — send to EQAvlWFDxGF2lXm67y4yzC3scvrcnxX_QvW7YDcGFXQ8ZACU</body></html>",
      ),
    );

    const result = await scanMiniAppContent(TARGET);
    const finding = result.findings.find(
      (f) => f.ruleId === "TELEGRAM_STARS_OFF_PROTOCOL_TON_DEMAND",
    );
    expect(finding?.evidence.tonAddresses).toEqual([
      { address: "EQAvlWFDxGF2lXm67y4yzC3scvrcnxX_QvW7YDcGFXQ8ZACU", form: "friendly" },
    ]);
  });

  it("fires on Russian off-protocol phrasing", async () => {
    mockedFetch.mockResolvedValue(
      okResponse("<html><body>Купить звёзды за TON. Быстро и дёшево.</body></html>"),
    );
    const result = await scanMiniAppContent(TARGET);
    expect(ruleIds(result.findings)).toContain("TELEGRAM_STARS_OFF_PROTOCOL_TON_DEMAND");
  });
});

describe("scanMiniAppContent — Stars discount lure", () => {
  it("fires TELEGRAM_STARS_DISCOUNT_LURE on `cheap telegram stars` phrasing", async () => {
    mockedFetch.mockResolvedValue(
      okResponse("<html><body>Cheap Telegram Stars — half-price stars all week.</body></html>"),
    );
    const result = await scanMiniAppContent(TARGET);
    const ids = ruleIds(result.findings);
    expect(ids).toContain("TELEGRAM_STARS_DISCOUNT_LURE");
    const finding = result.findings.find((f) => f.ruleId === "TELEGRAM_STARS_DISCOUNT_LURE");
    expect(finding?.confidence).toBe("medium");
  });

  it("upgrades discount-lure confidence to high when paired with off-protocol TON demand", async () => {
    mockedFetch.mockResolvedValue(
      okResponse(
        "<html><body>Cheap Stars on sale! Buy Stars with TON for the lowest price.</body></html>",
      ),
    );
    const result = await scanMiniAppContent(TARGET);
    const discount = result.findings.find((f) => f.ruleId === "TELEGRAM_STARS_DISCOUNT_LURE");
    const offProtocol = result.findings.find(
      (f) => f.ruleId === "TELEGRAM_STARS_OFF_PROTOCOL_TON_DEMAND",
    );
    expect(discount?.confidence).toBe("high");
    expect(offProtocol?.confidence).toBe("high");
  });

  it("upgrades discount-lure confidence to high when paired with credential phishing", async () => {
    mockedFetch.mockResolvedValue(
      okResponse(
        "<html><body>Discount stars! Enter your seed phrase to verify your wallet first.</body></html>",
      ),
    );
    const result = await scanMiniAppContent(TARGET);
    const discount = result.findings.find((f) => f.ruleId === "TELEGRAM_STARS_DISCOUNT_LURE");
    expect(discount?.confidence).toBe("high");
  });
});

// ── final URL evidence (redirect handling) ────────────────────────────────

describe("scanMiniAppContent — final URL after redirect", () => {
  it("uses finalUrl in evidence and notes requestedUrl when they differ", async () => {
    const finalUrl = new URL("https://redirected.example.com/landing");
    mockedFetch.mockResolvedValue({
      ok: true,
      value: {
        body: "Enter your seed phrase",
        contentType: "text/html",
        finalUrl,
      },
    });

    const result = await scanMiniAppContent(TARGET);
    const cred = result.findings.find((f) => f.ruleId === "TELEGRAM_MINIAPP_CREDENTIAL_PHISHING");
    expect(cred?.evidence).toMatchObject({
      url: finalUrl.toString(),
      requestedUrl: TARGET.toString(),
    });
  });
});
