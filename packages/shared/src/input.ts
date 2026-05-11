export const scanInputKinds = [
  "telegram_handle",
  "telegram_url",
  "telegram_deeplink",
  "telegram_miniapp_url",
  "telegram_nft_link",
  "tonconnect_link",
  "manifest_url",
  "generic_url",
  "ton_address",
  "boc",
  "transaction_json",
  "unknown",
] as const;

export type ScanInputKind = (typeof scanInputKinds)[number];

export interface BaseScanInput {
  readonly kind: ScanInputKind;
  readonly raw: string;
  readonly normalized: string;
}

export interface TelegramHandleInput extends BaseScanInput {
  readonly kind: "telegram_handle";
  readonly handle: `@${string}`;
}

export interface TelegramUrlInput extends BaseScanInput {
  readonly kind: "telegram_url";
  readonly url: URL;
  readonly handle: string | null;
}

/**
 * Telegram deep link with start-payload semantics. Distinguishes the
 * `start`/`startapp`/`startattach`/`startgroup`/`startchannel`/`startbusiness`
 * action carried by the URL from a plain channel link. See
 * <https://core.telegram.org/api/links> for the canonical grammar.
 *
 * Examples:
 *   - `t.me/somebot?start=abc` → action="start", bot="somebot", payload="abc"
 *   - `t.me/somebot?startapp=foo&mode=fullscreen` → action="startapp"
 *   - `t.me/somebot/someapp?startapp=foo` → action="startapp", appShortName="someapp"
 *   - `tg://addBusinessBot?...` → action="addBusinessBot", payload encodes rights
 */
export interface TelegramDeeplinkInput extends BaseScanInput {
  readonly kind: "telegram_deeplink";
  /** Original URL preserved for evidence. */
  readonly url: URL;
  /** Which action the deep link is requesting. */
  readonly action:
    | "start"
    | "startapp"
    | "startattach"
    | "startgroup"
    | "startchannel"
    | "startbusiness"
    | "addBusinessBot";
  /** The bot/peer this deep link targets, where applicable (without leading `@`). */
  readonly target: string | null;
  /** App short-name for `t.me/<bot>/<app>?startapp=...` style links. */
  readonly appShortName: string | null;
  /** The action-specific payload string (the right-hand side of the `start*=` query). */
  readonly payload: string | null;
  /**
   * Additional query parameters the parser captured (e.g. `mode=fullscreen`
   * on a startapp link, `admin=<perms>` on startgroup, `attach=<bot>` on a
   * peer-side startattach install, business-bot rights flags on addBusinessBot).
   * Carried through to evidence and the canonical hash so URLs that differ
   * only by these flags don't dedupe accidentally.
   */
  readonly extras: Readonly<Record<string, string>>;
}

/**
 * A direct Mini App URL — the page that loads in the Telegram WebView once
 * a Mini App is launched. These are NOT `t.me` URLs; they are the dApp's
 * own hosting. We classify them separately from `generic_url` so the
 * Telegram Mini App content scanner (PR-5) can apply its multilingual
 * lure-keyword set rather than the generic web-URL handling.
 *
 * Classification is conservative: a URL is only `telegram_miniapp_url` when
 * it was reached via a deep-link or forwarded message that proves the Mini
 * App context. Plain web URLs remain `generic_url` even if their content
 * happens to embed Telegram's Mini App SDK — we don't statically guess at
 * intent.
 *
 * **PR-2 state:** the type is declared (so the canonical-hash, serializer,
 * and cacheability code can branch on it forward-compatibly), but
 * `classifyInput` does NOT yet emit it — there is no Mini App context
 * upstream of `classifyInput` to mark a URL as Mini-App-hosted. PR-5 wires
 * the upstream context. Until then, Mini App URLs land as `generic_url`.
 */
export interface TelegramMiniappUrlInput extends BaseScanInput {
  readonly kind: "telegram_miniapp_url";
  readonly url: URL;
  /** The bot username that owns the Mini App, when discoverable from context. */
  readonly hostBot: string | null;
}

/**
 * `t.me/nft/<UniqueGift.name>` link — a Fragment-issued collectible gift
 * reference. Classified separately so the gift scanner (PR-6) can cross-
 * reference the slug against `getAvailableGifts` and the publisher registry.
 */
export interface TelegramNftLinkInput extends BaseScanInput {
  readonly kind: "telegram_nft_link";
  readonly url: URL;
  /** The UniqueGift slug after `t.me/nft/`. */
  readonly slug: string;
}

export interface TonConnectLinkInput extends BaseScanInput {
  readonly kind: "tonconnect_link";
  readonly requestId: string | null;
  readonly manifestUrl: URL;
  readonly returnStrategy: string | null;
}

export interface ManifestUrlInput extends BaseScanInput {
  readonly kind: "manifest_url";
  readonly url: URL;
}

export interface GenericUrlInput extends BaseScanInput {
  readonly kind: "generic_url";
  readonly url: URL;
}

export interface TonAddressInput extends BaseScanInput {
  readonly kind: "ton_address";
  readonly address: string;
}

export interface BocInput extends BaseScanInput {
  readonly kind: "boc";
  readonly boc: string;
}

export interface TransactionJsonInput extends BaseScanInput {
  readonly kind: "transaction_json";
  readonly transaction: Readonly<Record<string, unknown>>;
}

export interface UnknownInput extends BaseScanInput {
  readonly kind: "unknown";
  readonly reason: string;
}

export type ScanInput =
  | TelegramHandleInput
  | TelegramUrlInput
  | TelegramDeeplinkInput
  | TelegramMiniappUrlInput
  | TelegramNftLinkInput
  | TonConnectLinkInput
  | ManifestUrlInput
  | GenericUrlInput
  | TonAddressInput
  | BocInput
  | TransactionJsonInput
  | UnknownInput;
