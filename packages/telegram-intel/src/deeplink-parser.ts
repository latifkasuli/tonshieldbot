/**
 * Pure parser for Telegram t.me / tg:// deep-link grammar. Source:
 * <https://core.telegram.org/api/links>.
 *
 * Supported shapes (all distinguished in the returned discriminated union):
 *
 *   t.me/<bot>?start=<payload>                       → ParsedDeeplink.action="start"
 *   t.me/<bot>?startgroup[=<payload>]&admin=<perms>  → ParsedDeeplink.action="startgroup"
 *   t.me/<bot>?startchannel[=<payload>]              → ParsedDeeplink.action="startchannel"
 *   t.me/<bot>?startapp[=<payload>][&mode=...]       → ParsedDeeplink.action="startapp" (main Mini App)
 *   t.me/<bot>/<app>[?startapp=<payload>]            → ParsedDeeplink.action="startapp", appShortName set
 *   t.me/<bot>?startattach[=<payload>]               → ParsedDeeplink.action="startattach"
 *   t.me/<peer>?attach=<bot>&startattach=<payload>   → ParsedDeeplink.action="startattach", target=<peer>, plus attachBot
 *   t.me/<bot>?startbusiness=<payload>               → ParsedDeeplink.action="startbusiness"
 *   tg://addBusinessBot?bot=<bot>&rights=<flags>...  → ParsedDeeplink.action="addBusinessBot"
 *   t.me/nft/<slug>                                  → ParsedNft (separate result type — distinct from deep-link)
 *
 * Non-deep-link t.me URLs (e.g. plain `t.me/<channel>` with no start param)
 * are NOT deep links; the parser returns `{ kind: "not_deeplink" }` and the
 * classifier falls back to plain `telegram_url` handling.
 *
 * No I/O. No state. Easy to test exhaustively.
 */

export type ParsedTelegramUrl =
  | {
      readonly kind: "deeplink";
      readonly action:
        | "start"
        | "startapp"
        | "startattach"
        | "startgroup"
        | "startchannel"
        | "startbusiness"
        | "addBusinessBot";
      /** Target bot/peer username (lowercased, no leading `@`). */
      readonly target: string | null;
      /** App short-name for `t.me/<bot>/<app>` Mini App links. */
      readonly appShortName: string | null;
      /** Action-specific payload (e.g. start parameter, rights flags). */
      readonly payload: string | null;
      /**
       * Additional structured fields the action carries. Free-form so adding
       * new actions doesn't force a schema change — but each consumer
       * MUST know which keys it expects to read.
       *
       * Conventions:
       *   - `startattach` with `?attach=<bot>` (peer-side install) sets
       *     `extras.attachBot = "<bot>"` and `target` is the peer.
       *   - `startapp` with `?mode=fullscreen` sets `extras.mode = "fullscreen"`.
       *   - `startgroup`/`startchannel` with `?admin=<perms>` sets
       *     `extras.admin = "<perms>"`.
       *   - `addBusinessBot` rights flags land in `extras` as individual
       *     keys; consumer (PR-7) does the parsing.
       */
      readonly extras: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "nft";
      /** UniqueGift slug after `t.me/nft/`. */
      readonly slug: string;
    }
  | { readonly kind: "miniapp_indirect"; readonly hostBot: string | null }
  | { readonly kind: "plain_handle"; readonly handle: string }
  | { readonly kind: "not_telegram" }
  | { readonly kind: "not_deeplink" };

const TELEGRAM_HOSTS: ReadonlySet<string> = new Set(["t.me", "telegram.me", "telegram.dog"]);

const TG_SCHEME = "tg:";

const DEEPLINK_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "start",
  "startapp",
  "startattach",
  "startgroup",
  "startchannel",
  "startbusiness",
]);

const VALID_USERNAME = /^[A-Za-z0-9_]{4,32}$/;

/**
 * Top-level entry: parse any URL we believe might be Telegram-shaped.
 * Returns a discriminated union so callers can dispatch without `instanceof`
 * gymnastics. Non-Telegram URLs return `{ kind: "not_telegram" }`.
 */
export const parseTelegramUrl = (url: URL): ParsedTelegramUrl => {
  if (url.protocol === TG_SCHEME) {
    return parseTgScheme(url);
  }

  // Not a t.me / telegram.me hostname → not ours.
  if (!TELEGRAM_HOSTS.has(url.hostname.toLowerCase())) {
    return { kind: "not_telegram" };
  }

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  // `t.me/nft/<slug>` — Fragment collectible reference. Handled before bot/
  // channel branch so the literal `nft` prefix isn't mistaken for a handle.
  if (segments.length >= 2 && segments[0]?.toLowerCase() === "nft") {
    const slug = segments[1] ?? "";
    return slug.length > 0 ? { kind: "nft", slug } : { kind: "not_deeplink" };
  }

  // No path segments after host → bare `t.me/` link, no entity referenced.
  if (segments.length === 0) {
    return { kind: "not_deeplink" };
  }

  const first = segments[0] ?? "";

  // Special prefixes (proxy, addstickers, ...) are not deeplinks for our
  // purposes. We deliberately allowlist plain handles below rather than
  // denylisting every reserved prefix — a username starts with a letter
  // and matches the username regex.
  if (!VALID_USERNAME.test(first)) {
    return { kind: "not_deeplink" };
  }

  const target = first.toLowerCase();
  const appShortName = segments.length >= 2 && segments[1] !== undefined ? segments[1] : null;

  // Look for any of the deeplink-trigger query params. The first match wins
  // because Telegram itself prioritises by URL grammar ordering.
  for (const param of DEEPLINK_QUERY_PARAMS) {
    if (url.searchParams.has(param)) {
      return buildDeeplink(url, param, target, appShortName);
    }
  }

  // `t.me/<peer>?attach=<bot>` — peer-side attach install. Treat as
  // startattach with the peer as the target.
  if (url.searchParams.has("attach")) {
    return buildDeeplink(url, "startattach", target, appShortName);
  }

  // Plain `t.me/<handle>` with no query trigger → not a deep link, but a
  // handle reference. Useful signal for the classifier.
  if (appShortName === null) {
    return { kind: "plain_handle", handle: target };
  }

  // `t.me/<bot>/<app>` with no `startapp` query is still a Mini App
  // reference — Telegram launches it with empty payload.
  return {
    kind: "deeplink",
    action: "startapp",
    target,
    appShortName,
    payload: null,
    extras: {},
  };
};

const parseTgScheme = (url: URL): ParsedTelegramUrl => {
  // `tg://addBusinessBot?...` — business-bot connection request. The host
  // portion of a `tg://` URL parses as `url.host` in Node's WHATWG URL,
  // but Telegram canonicalises lowercase action verbs.
  const action = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();

  if (action === "addbusinessbot") {
    const target = url.searchParams.get("bot")?.toLowerCase() ?? null;
    const extras: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (key === "bot") continue;
      extras[key] = value;
    }
    return {
      kind: "deeplink",
      action: "addBusinessBot",
      target,
      appShortName: null,
      payload: url.searchParams.get("rights") ?? null,
      extras,
    };
  }

  // `tg://resolve?domain=<bot>&start=<payload>` is the URI equivalent of
  // `t.me/<bot>?start=<payload>`. Rewrite as t.me and re-parse so we get
  // a single canonical path.
  if (action === "resolve") {
    const domain = url.searchParams.get("domain");
    if (domain !== null && VALID_USERNAME.test(domain)) {
      const synthetic = new URL(`https://t.me/${domain}`);
      for (const [key, value] of url.searchParams) {
        if (key === "domain") continue;
        synthetic.searchParams.set(key, value);
      }
      return parseTelegramUrl(synthetic);
    }
  }

  return { kind: "not_deeplink" };
};

const buildDeeplink = (
  url: URL,
  param: string,
  target: string,
  appShortName: string | null,
): ParsedTelegramUrl => {
  const payload = url.searchParams.get(param);
  const extras: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key === param) continue;
    extras[key] = value;
  }

  const action = paramToAction(param);

  return {
    kind: "deeplink",
    action,
    target,
    appShortName,
    payload: payload === null || payload.length === 0 ? null : payload,
    extras,
  };
};

const paramToAction = (
  param: string,
): "start" | "startapp" | "startattach" | "startgroup" | "startchannel" | "startbusiness" => {
  // Exhaustive narrowing — `param` is constrained by DEEPLINK_QUERY_PARAMS
  // so all six cases are reachable and no default is needed.
  switch (param) {
    case "start":
    case "startapp":
    case "startattach":
    case "startgroup":
    case "startchannel":
    case "startbusiness":
      return param;
    default:
      // Unreachable given the caller's enum of DEEPLINK_QUERY_PARAMS;
      // narrowing helper for the type system.
      throw new Error(`unsupported deeplink param: ${param}`);
  }
};
