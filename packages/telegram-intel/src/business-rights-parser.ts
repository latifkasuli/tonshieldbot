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
 * On-wire format uncertainty: Telegram's public docs name the 14 fields
 * but do NOT publish the deep-link wire encoding alongside them. We have
 * observed two shapes in references:
 *
 *   1. Single-letter packed flags (e.g. `rights=rmcS...`), one letter per
 *      capability. This is the most likely production form because it
 *      keeps URLs short.
 *   2. Field-name token list (e.g. `rights=can_reply,can_read_messages`).
 *      Seen in some third-party explainers; may not be what Telegram
 *      itself emits.
 *
 * Rather than commit to one interpretation, this parser tries both:
 *
 *   - It walks the raw string char-by-char applying a best-effort letter
 *     table (see `LETTER_MAP`). Letters not in the table get reported in
 *     `unknown` so operators can audit. We never invent meanings.
 *   - It also looks for canonical field-name substrings (`transfer_stars`,
 *     `convert_gifts`, etc.). A field-name hit always wins over a
 *     conflicting letter interpretation.
 *
 * The raw string is always preserved on the result so evidence
 * downstream can show operators exactly what the URL claimed.
 *
 * Why parse format-flexibly: the deeplink scanner emits a
 * critical-severity finding when a dangerous right is requested. We must
 * not flag a benign URL just because we mis-decoded a letter. The
 * detection is robust if at least ONE strategy (letter map OR field
 * name) catches the dangerous flag; both strategies are additive, not
 * mutually exclusive.
 */

export type BusinessRight =
  | "can_reply"
  | "can_read_messages"
  | "can_delete_outgoing_messages"
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
 * Telegram's MTProto naming conventions where each business right flag is
 * typically referenced by a short token. We treat this as a hypothesis,
 * not authoritative: if a letter table proves wrong in production, the
 * field-name substring fallback still catches the dangerous cases, and
 * the `unknown` array surfaces the bad letters for correction.
 *
 * Case is significant — distinct lowercase / uppercase letters map to
 * distinct rights so we can fit all 14 rights in single chars without
 * digraphs. When a real-world URL contradicts this, fix the map in one
 * place rather than touching the rule logic.
 */
const LETTER_MAP: Readonly<Record<string, BusinessRight>> = {
  r: "can_reply",
  m: "can_read_messages",
  d: "can_delete_outgoing_messages",
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
 * Canonical Bot API field names for the field-name decoding fallback.
 * Used as substrings so we tolerate any token separator (`,` `+` `|`
 * whitespace) without committing to one.
 */
const FIELD_NAMES: readonly BusinessRight[] = [
  "can_reply",
  "can_read_messages",
  "can_delete_outgoing_messages",
  "can_delete_all_messages",
  "can_edit_name",
  "can_edit_bio",
  "can_edit_profile_photo",
  "can_edit_username",
  "can_change_gift_settings",
  "can_view_gifts_and_stars",
  "can_convert_gifts_to_stars",
  "can_transfer_and_upgrade_gifts",
  "can_transfer_stars",
  "can_manage_stories",
];

/**
 * Rights that grant irreversible / high-value capabilities. A single
 * one of these in a connection deep link is enough to fire the rule at
 * critical confidence. See the rule description in `risk-engine`.
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
 * Parse the raw `rights` payload. `null` / empty → empty result; never
 * throws. The `unknown` list contains decoded tokens we couldn't map AND
 * any leftover characters once the field-name substrings are removed.
 */
export const parseBusinessRights = (rawRights: string | null): BusinessRightsParseResult => {
  if (rawRights === null || rawRights.length === 0) {
    return { recognised: new Set(), unknown: [], raw: "" };
  }

  const recognised = new Set<BusinessRight>();

  // Strategy 1 — field-name substring scan. A field-name match is a
  // stronger signal than a letter match (it's literal English), so we
  // do this first and remove matched substrings from the residual
  // before the letter pass to avoid spurious "unknown" letters.
  let residual = rawRights;
  for (const field of FIELD_NAMES) {
    if (residual.includes(field)) {
      recognised.add(field);
      residual = residual.split(field).join("");
    }
  }

  // Strategy 2 — single-letter table over the residual. Letters not in
  // the table go to `unknown`. Separators (anything non-letter) are
  // ignored silently — `,+| ` etc. carry no information once we've
  // removed the field names.
  const unknown: string[] = [];
  for (const char of residual) {
    if (!/[A-Za-z]/.test(char)) continue;
    const mapped = LETTER_MAP[char];
    if (mapped !== undefined) {
      recognised.add(mapped);
    } else {
      unknown.push(char);
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
