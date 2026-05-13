/**
 * Pure parser for the `rights` payload on Telegram business-bot connection
 * deep links (`tg://addBusinessBot?bot=<bot>&rights=<rights>` and the
 * `t.me/<bot>?startbusiness=<state>` equivalent).
 *
 * What "rights" means here: each flag in `BusinessBotRights` (per the Bot
 * API spec) grants the bot a specific capability on the user's business
 * account — read messages, edit profile fields, transfer Stars, transfer
 * or upgrade gifts, manage stories, etc. The user is asked to consent
 * once at connection time; a careless connection gives the bot
 * irreversible powers (Stars and gifts in the business account become
 * the bot's to move).
 *
 * On-wire format uncertainty: Telegram's public docs name the field set
 * but do NOT publish the deep-link wire encoding alongside them. We've
 * observed two shapes in references:
 *
 *   1. Single-letter packed flags (e.g. `rights=rmst`), one letter per
 *      capability. Compact, used in some surfaces.
 *   2. Tokenised name list (e.g. `rights=can_read_messages,...` or the
 *      MTProto-style shorter `rights=read_messages,sell_gifts,...`).
 *      Names appear with or without the `can_` prefix.
 *
 * The parser handles both. To prevent a tokenised payload from being
 * misinterpreted as packed letters (e.g. `read_messages` would otherwise
 * decode into a spurious `can_transfer_stars` because `s` is in it), the
 * letter decoder runs ONLY when the input is a pure-letter string with
 * no separators or underscores. Tokenised inputs use alias matching
 * only.
 */

export type BusinessRight =
  | "can_reply"
  | "can_read_messages"
  | "can_delete_sent_messages"
  | "can_delete_all_messages"
  | "can_edit_name"
  | "can_edit_bio"
  | "can_edit_profile_photo"
  | "can_edit_username"
  | "can_change_gift_settings"
  | "can_view_gifts_and_stars"
  | "can_convert_gifts_to_stars"
  | "can_transfer_and_upgrade_gifts"
  | "can_transfer_stars"
  | "can_manage_stories";

export interface BusinessRightsParseResult {
  /** Set of rights recognised by either decoding strategy. */
  readonly recognised: ReadonlySet<BusinessRight>;
  /** Letters / tokens we couldn't map. Preserved for operator audit. */
  readonly unknown: readonly string[];
  /** The raw `rights` payload as it appeared on the URL. */
  readonly raw: string;
}

/**
 * Best-effort single-letter → BusinessRight mapping. Sourced from
 * Telegram's MTProto naming conventions where each business-right flag
 * is typically referenced by a short token. We treat this as a
 * hypothesis, not authoritative: if a letter table proves wrong in
 * production, the name-alias fallback still catches the dangerous cases,
 * and the `unknown` array surfaces the bad letters for correction.
 *
 * Case is significant — distinct lowercase / uppercase letters map to
 * distinct rights so we can fit the flag set in single chars without
 * digraphs. When a real-world URL contradicts this, fix the map in one
 * place rather than touching the rule logic.
 */
const LETTER_MAP: Readonly<Record<string, BusinessRight>> = {
  r: "can_reply",
  m: "can_read_messages",
  d: "can_delete_sent_messages",
  D: "can_delete_all_messages",
  n: "can_edit_name",
  b: "can_edit_bio",
  p: "can_edit_profile_photo",
  u: "can_edit_username",
  g: "can_change_gift_settings",
  v: "can_view_gifts_and_stars",
  c: "can_convert_gifts_to_stars",
  t: "can_transfer_and_upgrade_gifts",
  s: "can_transfer_stars",
  S: "can_manage_stories",
};

/**
 * Alias substrings → canonical BusinessRight. Covers the Bot API
 * canonical names (`can_*`) and the MTProto-style shorter names. Some
 * MTProto names don't have a 1:1 Bot API equivalent and are mapped to
 * the closest semantic neighbour (documented inline below).
 *
 * The list is consumed in declared order; we sort it longest-first at
 * module load so the substring scan can't be fooled by a shorter alias
 * being a prefix of a longer one (e.g. `transfer_stars` vs
 * `can_transfer_stars`).
 */
const NAME_ALIAS_ENTRIES: readonly [string, BusinessRight][] = [
  // Bot API canonical names (with `can_` prefix).
  ["can_reply", "can_reply"],
  ["can_read_messages", "can_read_messages"],
  ["can_delete_sent_messages", "can_delete_sent_messages"],
  ["can_delete_all_messages", "can_delete_all_messages"],
  ["can_edit_name", "can_edit_name"],
  ["can_edit_bio", "can_edit_bio"],
  ["can_edit_profile_photo", "can_edit_profile_photo"],
  ["can_edit_username", "can_edit_username"],
  ["can_change_gift_settings", "can_change_gift_settings"],
  ["can_view_gifts_and_stars", "can_view_gifts_and_stars"],
  ["can_convert_gifts_to_stars", "can_convert_gifts_to_stars"],
  ["can_transfer_and_upgrade_gifts", "can_transfer_and_upgrade_gifts"],
  ["can_transfer_stars", "can_transfer_stars"],
  ["can_manage_stories", "can_manage_stories"],

  // Legacy Bot API name kept for back-compat — earlier spec revisions
  // used `outgoing` where current uses `sent`.
  ["can_delete_outgoing_messages", "can_delete_sent_messages"],

  // MTProto-style names without `can_` prefix.
  ["reply", "can_reply"],
  ["read_messages", "can_read_messages"],
  ["delete_sent_messages", "can_delete_sent_messages"],
  ["delete_all_messages", "can_delete_all_messages"],
  // MTProto `delete_received_messages` doesn't have a direct Bot API
  // counterpart. Semantically, deleting incoming messages plus deleting
  // sent ones equals delete-all; we map it to the dangerous `_all_`
  // variant so the rule still fires.
  ["delete_received_messages", "can_delete_all_messages"],
  ["edit_name", "can_edit_name"],
  ["edit_bio", "can_edit_bio"],
  ["edit_profile_photo", "can_edit_profile_photo"],
  ["edit_username", "can_edit_username"],
  ["change_gift_settings", "can_change_gift_settings"],
  ["view_gifts_and_stars", "can_view_gifts_and_stars"],
  ["convert_gifts_to_stars", "can_convert_gifts_to_stars"],
  ["transfer_and_upgrade_gifts", "can_transfer_and_upgrade_gifts"],
  // MTProto `sell_gifts` is the resale capability — closest Bot API
  // analogue is `can_transfer_and_upgrade_gifts` because both move a
  // gift off the account for value extraction.
  ["sell_gifts", "can_transfer_and_upgrade_gifts"],
  ["transfer_stars", "can_transfer_stars"],
  ["manage_stories", "can_manage_stories"],
];

// Longest-first so a substring scan can't match `transfer_stars` inside
// `can_transfer_stars` before we've had a chance to match the longer form.
const NAME_ALIASES: readonly [string, BusinessRight][] = [...NAME_ALIAS_ENTRIES].sort(
  (a, b) => b[0].length - a[0].length,
);

/**
 * Rights that grant irreversible / high-value capabilities. A single
 * one of these in a connection deep link is enough to fire the
 * dangerous-rights rule.
 */
export const DANGEROUS_RIGHTS: ReadonlySet<BusinessRight> = new Set<BusinessRight>([
  "can_transfer_stars",
  "can_transfer_and_upgrade_gifts",
  "can_convert_gifts_to_stars",
  "can_delete_all_messages",
  "can_edit_username",
  "can_manage_stories",
]);

/**
 * "Packed" rights string = a short run of letters with NO separators.
 * If the input contains any non-letter character (underscore, comma,
 * plus, whitespace, dash, etc.), it is treated as tokenised and the
 * letter decoder is skipped — preventing word-like names like
 * `read_messages` from being shredded into spurious flag letters.
 */
const PACKED_PATTERN = /^[A-Za-z]+$/;

/**
 * Parse the raw `rights` payload. `null` / empty → empty result; never
 * throws.
 */
export const parseBusinessRights = (rawRights: string | null): BusinessRightsParseResult => {
  if (rawRights === null || rawRights.length === 0) {
    return { recognised: new Set(), unknown: [], raw: "" };
  }

  const recognised = new Set<BusinessRight>();

  // Strategy 1 — alias substring scan. Always runs. Longest aliases
  // first so `can_transfer_stars` is matched before bare
  // `transfer_stars` and we don't double-count.
  let residual = rawRights;
  for (const [alias, right] of NAME_ALIASES) {
    if (residual.includes(alias)) {
      recognised.add(right);
      residual = residual.split(alias).join("");
    }
  }

  const unknown: string[] = [];

  if (PACKED_PATTERN.test(rawRights)) {
    // Strategy 2 — single-letter decoder. Only run when the ORIGINAL
    // input is packed-shaped (pure letters). The residual is what's
    // left after the alias pass; for a packed input, alias matching
    // typically doesn't fire (no `_` in compact flags) so residual
    // equals rawRights.
    for (const char of residual) {
      const mapped = LETTER_MAP[char];
      if (mapped !== undefined) {
        recognised.add(mapped);
      } else {
        unknown.push(char);
      }
    }
  } else {
    // Tokenised input. Anything not matched by the alias pass becomes
    // an unknown token. Split on common separators so we don't report
    // long comma-joined leftovers as one big token.
    for (const token of residual.split(/[,+|_\s]+/)) {
      if (token.length > 0) unknown.push(token);
    }
  }

  return { recognised, unknown, raw: rawRights };
};

/**
 * Convenience predicate: does the parsed payload include any
 * dangerous-tier right? Used by the deeplink scanner to pick severity.
 */
export const includesDangerousRight = (result: BusinessRightsParseResult): boolean => {
  for (const right of result.recognised) {
    if (DANGEROUS_RIGHTS.has(right)) return true;
  }
  return false;
};
