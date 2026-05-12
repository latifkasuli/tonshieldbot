import { describe, expect, it } from "vitest";
import { analyseMiniAppContent } from "../src/miniapp-content.ts";

// ── credential phishing ───────────────────────────────────────────────────

describe("analyseMiniAppContent — credential phishing (EN)", () => {
  it("flags a 12-word seed-phrase prompt", () => {
    const body =
      "<html><body><h1>Restore wallet</h1><p>Enter your 12 word seed phrase below to continue.</p><form><input/></form></body></html>";
    const report = analyseMiniAppContent(body);

    expect(report.credentialPhishingMatches.length).toBeGreaterThanOrEqual(2);
    const categories = new Set(report.credentialPhishingMatches.map((m) => m.category));
    expect(categories).toContain("seed_phrase");
    expect(report.languagesSeen).toContain("en");
  });

  it("flags a Telegram-login-code prompt", () => {
    const body =
      "<html><body>Please share the 6-digit code you receive from Telegram to verify your identity.</body></html>";
    const report = analyseMiniAppContent(body);

    expect(report.credentialPhishingMatches.some((m) => m.category === "login_code")).toBe(true);
  });

  it("flags a private-key import prompt", () => {
    const body = "<html><body>Paste your private key here to import the wallet.</body></html>";
    const report = analyseMiniAppContent(body);
    expect(report.credentialPhishingMatches.some((m) => m.category === "private_key")).toBe(true);
  });

  it("flags a 2FA / cloud-password ask", () => {
    const body = "<html><body>Enter your Telegram cloud password to continue.</body></html>";
    const report = analyseMiniAppContent(body);
    expect(report.credentialPhishingMatches.some((m) => m.category === "two_factor")).toBe(true);
  });
});

describe("analyseMiniAppContent — credential phishing (multilingual)", () => {
  it("flags Russian seed-phrase prompt (сид-фраза)", () => {
    const body =
      "<html><body><h1>Восстановить кошелёк</h1><p>Введите вашу сид-фразу для продолжения.</p></body></html>";
    const report = analyseMiniAppContent(body);
    expect(report.credentialPhishingMatches.some((m) => m.category === "seed_phrase")).toBe(true);
    expect(report.languagesSeen).toContain("ru");
  });

  it("flags Spanish seed-phrase prompt (frase semilla)", () => {
    const body =
      "<html><body>Ingresa tu frase semilla de 12 palabras para recuperar tu wallet.</body></html>";
    const report = analyseMiniAppContent(body);
    expect(report.credentialPhishingMatches.some((m) => m.category === "seed_phrase")).toBe(true);
    expect(report.languagesSeen).toContain("es");
  });

  it("flags Chinese seed-phrase prompt (助记词)", () => {
    const body = "<html><body>请输入您的助记词以恢复钱包。</body></html>";
    const report = analyseMiniAppContent(body);
    expect(report.credentialPhishingMatches.some((m) => m.category === "seed_phrase")).toBe(true);
    expect(report.languagesSeen).toContain("zh");
  });

  it("flags a multilingual page that mixes scam language across two languages", () => {
    const body = "<html><body><p>Enter your seed phrase</p><p>请输入您的私钥</p></body></html>";
    const report = analyseMiniAppContent(body);
    expect(report.languagesSeen).toContain("en");
    expect(report.languagesSeen).toContain("zh");
  });
});

// ── lure language ─────────────────────────────────────────────────────────

describe("analyseMiniAppContent — lure language", () => {
  it("flags 'claim your airdrop' (EN)", () => {
    const body = "<html><body>Claim your airdrop now — limited time only!</body></html>";
    const report = analyseMiniAppContent(body);
    expect(report.lureMatches.some((m) => m.category === "airdrop_lure")).toBe(true);
    expect(report.lureMatches.some((m) => m.category === "urgency_pressure")).toBe(true);
  });

  it("flags 'free Telegram Premium' gift bait (EN)", () => {
    const body = "<html><body>Free Telegram Premium for the first 100 users!</body></html>";
    const report = analyseMiniAppContent(body);
    expect(report.lureMatches.some((m) => m.category === "gift_lure")).toBe(true);
  });

  it("flags Russian 'забрать airdrop'", () => {
    const body = "<html><body>Нажмите чтобы забрать airdrop в TON.</body></html>";
    const report = analyseMiniAppContent(body);
    expect(report.lureMatches.some((m) => m.category === "airdrop_lure")).toBe(true);
  });

  it("flags gift-upgrade fee lure (the 'send TON to upgrade' pattern)", () => {
    const body =
      "<html><body>Upgrade your gift to NFT. Send TON to upgrade — only 0.5 TON fee.</body></html>";
    const report = analyseMiniAppContent(body);
    expect(report.lureMatches.some((m) => m.category === "gift_upgrade_lure")).toBe(true);
  });

  it("does NOT flag generic word 'wallet' alone (must be phrase-shaped)", () => {
    // 'wallet' as a single word appears on legitimate pages constantly.
    // Lure keywords are phrase-shaped to avoid this.
    const body = "<html><body>Connect your wallet to view your portfolio.</body></html>";
    const report = analyseMiniAppContent(body);
    expect(report.lureMatches).toEqual([]);
  });
});

// ── APK detection ─────────────────────────────────────────────────────────

describe("analyseMiniAppContent — APK download detection", () => {
  it("flags a direct .apk href", () => {
    const body =
      '<html><body><a href="https://femitbot-cdn.example.com/downloads/NVIDIA_App_v2.1.apk">Download App</a></body></html>';
    const report = analyseMiniAppContent(body);
    expect(report.apkLinks.length).toBe(1);
    expect(report.apkLinks[0]?.filename).toBe("NVIDIA_App_v2.1.apk");
  });

  it("flags an .apk URL with query string", () => {
    const body =
      '<html><body><a href="https://example.com/app.apk?token=abc123&v=5">Get it</a></body></html>';
    const report = analyseMiniAppContent(body);
    expect(report.apkLinks).toHaveLength(1);
    expect(report.apkLinks[0]?.filename).toBe("app.apk");
  });

  it("flags an APK reference in unquoted / minified markup", () => {
    // Scam pages frequently use unquoted attributes or inline JS strings.
    // The substring-based regex catches these.
    const body = "window.open('https://malware-cdn.example.com/payload.apk','_blank');";
    const report = analyseMiniAppContent(body);
    expect(report.apkLinks).toHaveLength(1);
  });

  it("deduplicates the same APK link appearing multiple times", () => {
    const body =
      '<a href="https://example.com/x.apk">A</a><a href="https://example.com/x.apk">B</a>';
    const report = analyseMiniAppContent(body);
    expect(report.apkLinks).toHaveLength(1);
  });

  it("ignores .apk strings in JSON keys / non-URL contexts", () => {
    // No URL-shaped pattern → no match.
    const body = '<script>const config = { "android_apk": "filename.apk" }</script>';
    const report = analyseMiniAppContent(body);
    expect(report.apkLinks).toHaveLength(0);
  });
});

// ── clean pages ───────────────────────────────────────────────────────────

describe("analyseMiniAppContent — clean / legitimate Mini Apps", () => {
  it("produces no findings on a benign page", () => {
    const body =
      "<html><body><h1>Welcome to our Mini App</h1><p>Use the menu to navigate.</p></body></html>";
    const report = analyseMiniAppContent(body);
    expect(report.credentialPhishingMatches).toEqual([]);
    expect(report.lureMatches).toEqual([]);
    expect(report.apkLinks).toEqual([]);
  });

  it("produces no findings on a page using cryptography terminology benignly", () => {
    // A legitimate wallet docs page might mention 'private key' in
    // educational context — but the keyword for that category is
    // 'private key' phrase-shaped, which DOES match. This documents the
    // known false-positive: the rule is intentionally aggressive on
    // credential keywords because the cost of missing real phishing is
    // higher than over-flagging documentation pages.
    const body =
      "<html><body><h1>How wallets work</h1><p>A wallet uses public and private key cryptography.</p></body></html>";
    const report = analyseMiniAppContent(body);
    // We expect this to match — documenting the tradeoff in tests so
    // anyone tuning thresholds knows the rule's bias.
    expect(report.credentialPhishingMatches.length).toBeGreaterThan(0);
  });

  it("returns empty for an empty body", () => {
    const report = analyseMiniAppContent("");
    expect(report.credentialPhishingMatches).toEqual([]);
    expect(report.lureMatches).toEqual([]);
    expect(report.apkLinks).toEqual([]);
    expect(report.languagesSeen).toEqual([]);
  });
});

// ── case insensitivity / robustness ──────────────────────────────────────

describe("analyseMiniAppContent — case insensitivity & robustness", () => {
  it("matches keywords regardless of HTML body case", () => {
    const upper = "<HTML><BODY>ENTER YOUR SEED PHRASE</BODY></HTML>";
    const lower = "<html><body>enter your seed phrase</body></html>";
    const mixed = "<Html><Body>Enter Your SEED PHRASE</Body></Html>";

    for (const body of [upper, lower, mixed]) {
      const report = analyseMiniAppContent(body);
      expect(report.credentialPhishingMatches.some((m) => m.category === "seed_phrase")).toBe(true);
    }
  });

  it("deduplicates the exact same phrase appearing multiple times", () => {
    const body =
      "Enter your seed phrase. Type the seed phrase carefully. Confirm the seed phrase one more time.";
    const report = analyseMiniAppContent(body);
    const sameCategory = report.credentialPhishingMatches.filter((m) => m.phrase === "seed phrase");
    expect(sameCategory).toHaveLength(1);
  });
});
