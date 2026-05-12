import { describe, expect, it } from "vitest";
import { parseGiftPage } from "../src/gift-link-resolver.ts";

// Fixture modeled on the live `t.me/nft/PlushPepe-10` page (empirically
// captured 2026-05). Reduced to the meta tags we depend on.
const REAL_GIFT_PAGE = `
<!DOCTYPE html>
<html>
  <head>
    <title>Telegram: Collectible Gift</title>
    <meta property="og:title" content="Plush Pepe #10" />
    <meta property="og:description" content="Model: Bavaria&#10;Backdrop: Turquoise&#10;Symbol: Flying Heart" />
    <meta property="og:image" content="https://cdn4.telesco.pe/file/abc.jpg" />
    <meta property="al:ios:url" content="tg://nft?slug=PlushPepe-10" />
  </head>
  <body>...</body>
</html>
`;

// What Telegram returns when the slug doesn't exist: a 302 to the
// homepage. `safeFetch` follows the redirect, so what reaches the parser
// is the homepage body — no gift markers at all.
const TELEGRAM_HOMEPAGE = `
<!DOCTYPE html>
<html>
  <head>
    <title>Telegram – a new era of messaging</title>
    <meta property="og:title" content="Telegram" />
  </head>
  <body>...</body>
</html>
`;

describe("parseGiftPage — verified", () => {
  it("verifies a slug when al:ios:url echoes the expected slug", () => {
    const result = parseGiftPage(REAL_GIFT_PAGE, "PlushPepe-10");
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    expect(result.metadata.title).toBe("Plush Pepe #10");
    expect(result.metadata.canonicalSlug).toBe("PlushPepe-10");
    expect(result.metadata.giftName).toBe("PlushPepe");
    expect(result.metadata.collectibleNumber).toBe(10);
    expect(result.metadata.model).toBe("Bavaria");
    expect(result.metadata.backdrop).toBe("Turquoise");
    expect(result.metadata.symbol).toBe("Flying Heart");
    expect(result.metadata.imageUrl).toBe("https://cdn4.telesco.pe/file/abc.jpg");
  });

  it("accepts case-insensitive slug equality (shared links often lowercased)", () => {
    const result = parseGiftPage(REAL_GIFT_PAGE, "plushpepe-10");
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    // Canonical case is preserved from the echo, not the input.
    expect(result.metadata.canonicalSlug).toBe("PlushPepe-10");
  });

  it("handles meta tag attribute reordering (content before property)", () => {
    const reordered = `
      <meta content="Plush Pepe #10" property="og:title" />
      <meta content="tg://nft?slug=PlushPepe-10" property="al:ios:url" />
    `;
    const result = parseGiftPage(reordered, "PlushPepe-10");
    expect(result.status).toBe("verified");
  });

  it("falls back to canonical slug as title when og:title is missing", () => {
    const noTitle = `
      <meta property="al:ios:url" content="tg://nft?slug=PlushPepe-10" />
    `;
    const result = parseGiftPage(noTitle, "PlushPepe-10");
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    expect(result.metadata.title).toBe("PlushPepe-10");
  });
});

describe("parseGiftPage — not_verified", () => {
  it("returns slug_marker_mismatch when al:ios:url echoes a DIFFERENT slug", () => {
    const wrongSlug = REAL_GIFT_PAGE.replace("PlushPepe-10", "PlushPepe-9999");
    // The body now claims PlushPepe-9999. User asked about PlushPepe-10.
    const result = parseGiftPage(wrongSlug, "PlushPepe-10");
    expect(result.status).toBe("not_verified");
    if (result.status !== "not_verified") return;
    expect(result.reason).toBe("slug_marker_mismatch");
  });

  it("returns slug_marker_missing when al:ios:url is absent but og:title is present", () => {
    const noMarker = `
      <meta property="og:title" content="Some other page" />
    `;
    const result = parseGiftPage(noMarker, "PlushPepe-10");
    expect(result.status).toBe("not_verified");
    if (result.status !== "not_verified") return;
    expect(result.reason).toBe("slug_marker_missing");
  });

  it("returns non_gift_page when both al:ios:url and og:title are absent", () => {
    const result = parseGiftPage("<html><body>nothing here</body></html>", "PlushPepe-10");
    expect(result.status).toBe("not_verified");
    if (result.status !== "not_verified") return;
    expect(result.reason).toBe("non_gift_page");
  });

  it("returns non_gift_page for the Telegram homepage redirect body", () => {
    const result = parseGiftPage(TELEGRAM_HOMEPAGE, "PlushPepe-10");
    expect(result.status).toBe("not_verified");
    if (result.status !== "not_verified") return;
    // homepage has og:title="Telegram" → slug_marker_missing path
    expect(result.reason).toBe("slug_marker_missing");
  });

  it("rejects malformed expected slugs defensively", () => {
    const result = parseGiftPage(REAL_GIFT_PAGE, "not a slug");
    expect(result.status).toBe("not_verified");
    if (result.status !== "not_verified") return;
    expect(result.reason).toBe("slug_marker_mismatch");
  });

  it("returns slug_marker_missing when al:ios:url is malformed (not tg://nft?slug=...)", () => {
    const broken = `
      <meta property="al:ios:url" content="tg://something-else" />
      <meta property="og:title" content="Plush Pepe #10" />
    `;
    const result = parseGiftPage(broken, "PlushPepe-10");
    expect(result.status).toBe("not_verified");
    if (result.status !== "not_verified") return;
    expect(result.reason).toBe("slug_marker_missing");
  });
});

describe("parseGiftPage — metadata parsing edge cases", () => {
  it("populates only the attributes present in og:description", () => {
    const partial = `
      <meta property="og:title" content="Plush Pepe #10" />
      <meta property="og:description" content="Model: Bavaria" />
      <meta property="al:ios:url" content="tg://nft?slug=PlushPepe-10" />
    `;
    const result = parseGiftPage(partial, "PlushPepe-10");
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    expect(result.metadata.model).toBe("Bavaria");
    expect(result.metadata.backdrop).toBeNull();
    expect(result.metadata.symbol).toBeNull();
  });

  it("returns null for imageUrl when og:image is absent", () => {
    const noImage = `
      <meta property="og:title" content="Plush Pepe #10" />
      <meta property="al:ios:url" content="tg://nft?slug=PlushPepe-10" />
    `;
    const result = parseGiftPage(noImage, "PlushPepe-10");
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    expect(result.metadata.imageUrl).toBeNull();
  });

  it("decodes HTML entities in metadata fields", () => {
    const entities = `
      <meta property="og:title" content="Plush Pepe &amp; Friends #10" />
      <meta property="og:description" content="Model: Bavaria&#10;Backdrop: Turquoise" />
      <meta property="al:ios:url" content="tg://nft?slug=PlushPepe-10" />
    `;
    const result = parseGiftPage(entities, "PlushPepe-10");
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    expect(result.metadata.title).toBe("Plush Pepe & Friends #10");
    expect(result.metadata.model).toBe("Bavaria");
    expect(result.metadata.backdrop).toBe("Turquoise");
  });
});
