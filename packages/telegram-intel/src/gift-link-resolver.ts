/**
 * Pure parser for Telegram's public collectible-gift pages at
 * `https://t.me/nft/<slug>`. No I/O — the scanner layer (in
 * `@tonshield/ton-scanner`) does the `safeFetch` and hands the resulting
 * body here.
 *
 * What a valid gift page exposes (empirically captured from `PlushPepe-10`,
 * a real Fragment-issued collectible):
 *
 *   <title>Telegram: Collectible Gift</title>
 *   <meta property="og:title" content="Plush Pepe #10">
 *   <meta property="og:description" content="Model: Bavaria\nBackdrop: ...">
 *   <meta property="og:image" content="https://cdn4.telesco.pe/file/...">
 *   <meta property="al:ios:url" content="tg://nft?slug=PlushPepe-10">
 *
 * Detection contract: a slug is **verified** when the page is fetched
 * successfully and `al:ios:url` contains `tg://nft?slug=<expected>`. The
 * Telegram `al:` meta is server-controlled, so it's a tamper-resistant
 * proof that the slug resolves to a live collectible.
 *
 * What a missing/fake slug looks like: Telegram returns a 302 to
 * `https://telegram.org/`. Empirically verified — `safeFetch` follows
 * the redirect, the response body is the Telegram homepage, no
 * `al:ios:url` marker is present.
 *
 * Why not `payments.getUniqueStarGift(slug)` instead: that MTProto method
 * is officially marked **user-only**, not bot-usable per the API spec.
 * MTProto sidecar work is deferred indefinitely — current preference is
 * TON-on-chain lookup against the username/gift NFT contracts when that
 * surface is ready. Until then, the public page scrape is the only
 * authoritative resolver we have.
 *
 * **Scope limitation** (documented for the rule description): a verified
 * gift page proves the slug RESOLVES to a real collectible. It does NOT
 * prove the gift instance was sent by a legitimate publisher — that's
 * what the owner-inventory path (`scanChatGiftsForUnknownPublisher` in
 * `@tonshield/ton-scanner`) does for chats the bot can access.
 */

const SLUG_PATTERN = /^[A-Za-z0-9]+-\d+$/;

export type GiftLinkResolution =
  | {
      readonly status: "verified";
      readonly metadata: GiftMetadata;
    }
  | {
      readonly status: "not_verified";
      readonly reason: GiftLinkNotVerifiedReason;
    };

export type GiftLinkNotVerifiedReason =
  | "slug_marker_missing"
  | "slug_marker_mismatch"
  | "non_gift_page"
  | "redirected_off_path";

export interface GiftMetadata {
  /** Display title as Telegram shows it, e.g. "Plush Pepe #10". */
  readonly title: string;
  /**
   * The exact slug Telegram echoes back via the `al:ios:url` meta —
   * canonical form. Casing follows Telegram's.
   */
  readonly canonicalSlug: string;
  /** Parsed gift design name (without the `-<number>` suffix). */
  readonly giftName: string;
  /** Parsed collectible number (the integer after the dash). */
  readonly collectibleNumber: number;
  /** Model attribute when present in og:description (e.g. "Bavaria"). */
  readonly model: string | null;
  /** Backdrop attribute when present (e.g. "Turquoise"). */
  readonly backdrop: string | null;
  /** Symbol attribute when present (e.g. "Flying Heart"). */
  readonly symbol: string | null;
  /** Gift image URL when present. */
  readonly imageUrl: string | null;
}

/**
 * Parse a fetched `t.me/nft/<slug>` page body and decide whether the
 * page genuinely represents the expected gift.
 *
 * `expectedSlug` is the slug from the user's input URL (e.g.
 * `PlushPepe-10`). We compare it case-INSENSITIVELY against the
 * `al:ios:url` echo, because Telegram doesn't enforce case in the URL
 * but DOES preserve the canonical case in the echo. A mismatch in
 * canonical case is recorded but does NOT fail verification (it's
 * common for shared links to be lower-cased).
 */
export const parseGiftPage = (htmlBody: string, expectedSlug: string): GiftLinkResolution => {
  if (!SLUG_PATTERN.test(expectedSlug)) {
    // Malformed slug — the caller (classifier) should have rejected this,
    // but defend against it here too.
    return { status: "not_verified", reason: "slug_marker_mismatch" };
  }

  const alIosUrl = extractMeta(htmlBody, "al:ios:url");
  const ogTitle = extractMeta(htmlBody, "og:title");

  if (alIosUrl === null) {
    // No `al:ios:url` → not a Telegram gift page. Most likely the
    // request landed on Telegram's homepage after a 302 (the signature
    // failure mode for missing slugs).
    return {
      status: "not_verified",
      reason: ogTitle === null ? "non_gift_page" : "slug_marker_missing",
    };
  }

  const echoSlug = extractSlugFromAlUrl(alIosUrl);

  if (echoSlug === null) {
    return { status: "not_verified", reason: "slug_marker_missing" };
  }

  if (echoSlug.toLowerCase() !== expectedSlug.toLowerCase()) {
    return { status: "not_verified", reason: "slug_marker_mismatch" };
  }

  const title = ogTitle ?? echoSlug;
  const { giftName, collectibleNumber } = splitSlug(echoSlug);
  const ogDescription = extractMeta(htmlBody, "og:description");
  const attributes = ogDescription === null ? {} : parseAttributes(ogDescription);

  return {
    status: "verified",
    metadata: {
      title,
      canonicalSlug: echoSlug,
      giftName,
      collectibleNumber,
      model: attributes.model ?? null,
      backdrop: attributes.backdrop ?? null,
      symbol: attributes.symbol ?? null,
      imageUrl: extractMeta(htmlBody, "og:image"),
    },
  };
};

// ── meta-tag extraction ───────────────────────────────────────────────────

/**
 * Pull a single `<meta property="X" content="Y">` or
 * `<meta name="X" content="Y">` value from the body. Tolerates attribute
 * reordering (Telegram's pages have `property` before `content`, but a
 * future markup change could flip them).
 *
 * Returns the FIRST match — Telegram doesn't ship duplicate
 * `og:*` tags in practice. Returns `null` when not found.
 */
const extractMeta = (body: string, propertyName: string): string | null => {
  // Pattern A: <meta property="X" content="Y"> or <meta name="X" content="Y">
  const propFirst = new RegExp(
    `<meta\\s+(?:property|name)\\s*=\\s*["']${escapeRegExp(propertyName)}["']\\s+content\\s*=\\s*["']([^"']*)["']`,
    "i",
  );
  const matchA = propFirst.exec(body);
  if (matchA !== null) return decodeBasicEntities(matchA[1] ?? "");

  // Pattern B: <meta content="Y" property="X">
  const contentFirst = new RegExp(
    `<meta\\s+content\\s*=\\s*["']([^"']*)["']\\s+(?:property|name)\\s*=\\s*["']${escapeRegExp(propertyName)}["']`,
    "i",
  );
  const matchB = contentFirst.exec(body);
  if (matchB !== null) return decodeBasicEntities(matchB[1] ?? "");

  return null;
};

const extractSlugFromAlUrl = (alIosUrl: string): string | null => {
  // Telegram's form: `tg://nft?slug=PlushPepe-10`
  const match = /^tg:\/\/nft\?slug=([^&\s]+)/i.exec(alIosUrl);
  if (match === null) return null;
  const slug = match[1] ?? null;
  if (slug === null || !SLUG_PATTERN.test(slug)) return null;
  return slug;
};

const splitSlug = (slug: string): { giftName: string; collectibleNumber: number } => {
  // SLUG_PATTERN already guarantees the shape; the split is total.
  const dash = slug.lastIndexOf("-");
  const giftName = slug.slice(0, dash);
  const collectibleNumber = Number.parseInt(slug.slice(dash + 1), 10);
  return { giftName, collectibleNumber };
};

/**
 * Parse the `Model: X\nBackdrop: Y\nSymbol: Z` shape Telegram uses in
 * `og:description`. Three of these attributes are always present on a
 * Fragment-issued unique gift; we surface them verbatim for the action
 * preview rendered to the user.
 */
const parseAttributes = (
  description: string,
): { model?: string; backdrop?: string; symbol?: string } => {
  const result: { model?: string; backdrop?: string; symbol?: string } = {};
  // Telegram uses real newlines OR `&#10;` HTML-encoded; both reach us as
  // newlines after decodeBasicEntities. Split on either.
  for (const line of description.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (value.length === 0) continue;
    if (key === "model") result.model = value;
    else if (key === "backdrop") result.backdrop = value;
    else if (key === "symbol") result.symbol = value;
  }
  return result;
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const decodeBasicEntities = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#10;/g, "\n");
