import { createFinding, getCoreRule } from "@tonshield/risk-engine";
import type { ActionPreview, RiskFinding } from "@tonshield/shared";
import {
  includesDangerousRight,
  parseBusinessRights,
  type BusinessRight,
  type BusinessRightsParseResult,
} from "@tonshield/telegram-intel";

/**
 * Scanner for business-bot connection deep links. Two deep-link surfaces
 * land here, both already classified by the upstream parser:
 *
 *   - `tg://addBusinessBot?bot=<bot>&rights=<rights>` — primary form,
 *     emitted by Telegram clients. `payload` carries the `rights` string.
 *   - `t.me/<bot>?startbusiness=<state>` — web-share form. The bot
 *     pre-declares rights server-side; the URL itself does not always
 *     carry them. When no `rights=` extra is present we still emit a
 *     low-confidence informational finding so the user is warned that
 *     this is a business connection request, but we cannot enumerate
 *     specific rights from the URL alone.
 *
 * Two rules are wired through this scanner:
 *
 *   - `TELEGRAM_BUSINESS_DEEPLINK_DANGEROUS_RIGHTS` (critical) when the
 *     parsed rights include any irreversible-harm flag (transfer Stars,
 *     transfer/upgrade gifts, convert gifts, edit username, manage
 *     stories, delete-all-messages).
 *   - `TELEGRAM_BUSINESS_DEEPLINK_BROAD_RIGHTS` (high) when the parser
 *     recognises ≥3 rights but NONE of them are in the dangerous set —
 *     surveillance + impersonation precursor pattern without a smoking
 *     gun.
 *
 * The scanner is pure: no I/O, no Bot API call. It runs synchronously
 * from `basic-scan` after the deeplink parser has classified the input.
 */

export interface BusinessDeeplinkScanInput {
  /** The `target` field from the parsed deeplink — the bot's @handle. */
  readonly target: string | null;
  /**
   * The `rights` payload as it appeared on the URL. For `addBusinessBot`
   * deep links this is `extras.rights` or `payload`; for `startbusiness`
   * it may also live on `extras.rights`. Pass whichever is non-null.
   */
  readonly rawRights: string | null;
  /** The deeplink action — used purely for evidence rendering. */
  readonly action: "addBusinessBot" | "startbusiness";
}

export interface BusinessDeeplinkScanResult {
  readonly findings: readonly RiskFinding[];
  readonly actions: readonly ActionPreview[];
}

const EMPTY_RESULT: BusinessDeeplinkScanResult = { findings: [], actions: [] };
const BROAD_RIGHTS_THRESHOLD = 3;

export const scanBusinessDeeplink = (
  input: BusinessDeeplinkScanInput,
): BusinessDeeplinkScanResult => {
  const parsed = parseBusinessRights(input.rawRights);

  if (includesDangerousRight(parsed)) {
    return {
      findings: [
        createFinding({
          confidence: "high",
          evidence: evidenceFor(input, parsed),
          rule: getCoreRule("TELEGRAM_BUSINESS_DEEPLINK_DANGEROUS_RIGHTS"),
        }),
      ],
      actions: [],
    };
  }

  if (parsed.recognised.size >= BROAD_RIGHTS_THRESHOLD) {
    return {
      findings: [
        createFinding({
          confidence: "medium",
          evidence: evidenceFor(input, parsed),
          rule: getCoreRule("TELEGRAM_BUSINESS_DEEPLINK_BROAD_RIGHTS"),
        }),
      ],
      actions: [],
    };
  }

  return EMPTY_RESULT;
};

const evidenceFor = (
  input: BusinessDeeplinkScanInput,
  parsed: BusinessRightsParseResult,
): Readonly<Record<string, unknown>> => {
  // Sort for stable evidence ordering across scans.
  const recognised: readonly BusinessRight[] = Array.from(parsed.recognised).sort();
  return {
    action: input.action,
    ...(input.target === null ? {} : { target: input.target }),
    recognisedRights: recognised,
    recognisedCount: recognised.length,
    ...(parsed.unknown.length === 0 ? {} : { unknownTokens: parsed.unknown }),
    rawRights: parsed.raw,
  };
};
