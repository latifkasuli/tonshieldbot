import { createFinding, getCoreRule } from "@tonshield/risk-engine";
import type { ActionPreview, BocInput, RiskFinding } from "@tonshield/shared";
import {
  emulateMessageToEvent,
  type EmulatedAction,
  type EmulatedActionKind,
  type EventsEmulateOk,
  type TonEmulatorClient,
} from "@tonshield/ton-emulator";

export interface BocScanResult {
  readonly findings: readonly RiskFinding[];
  readonly actions: readonly ActionPreview[];
}

/**
 * Scans a raw BOC input by routing it through `/v2/events/emulate` and
 * mapping the resulting action list and `is_scam` flag onto findings.
 *
 * Why a separate scanner from `scanTransactionWithEmulation`:
 *   - Raw BOC inputs have NO static decode counterpart. M1.5's
 *     `scanTransactionJson` operates on the parsed TON Connect transaction
 *     shape (`{ valid_until, messages: [...] }`), which a base64 BOC is
 *     not. Without a static side, the diff module has nothing to compare
 *     against, so `EMULATION_MISMATCH` and `EMULATION_REVEALED_HIDDEN_ACTION`
 *     cannot fire on this path.
 *   - The events-emulate endpoint provides no `risk` object (so
 *     `EMULATION_SENDS_NEAR_FULL_BALANCE` would have no honest source) and
 *     no trace shape (so `EMULATION_ABORTED` would have no honest source).
 *     Both are intentionally suppressed.
 *
 * Findings that ARE emitted on this path:
 *   - `EMULATION_NOT_CONFIGURED` when emulator is absent/disabled
 *   - `EMULATION_RATE_LIMITED` / `EMULATION_PROVIDER_DOWN` / `EMULATION_FAILED`
 *     for provider failures (shared classification with PR-D1)
 *   - `EMULATION_SCAM_PATTERN_DETECTED` when TONAPI flags the event as scam
 *   - `EMULATION_WALLET_V5_AUTH_CHANGE` for AddExtension / RemoveExtension /
 *     SetSignatureAllowed actions in the emulated event (per-action signal,
 *     independent of static-vs-emulated comparison or risk summary)
 *
 * Plus the action previews themselves — the highest-value addition for BOC
 * inputs, which previously surfaced as empty action lists.
 */
export const scanBocWithEmulation = async (
  client: TonEmulatorClient | undefined,
  input: BocInput,
): Promise<BocScanResult> => {
  if (!client?.enabled) {
    return {
      findings: [
        createFinding({
          confidence: "low",
          evidence: {},
          rule: getCoreRule("EMULATION_NOT_CONFIGURED"),
        }),
      ],
      actions: [],
    };
  }

  let result: Awaited<ReturnType<typeof emulateMessageToEvent>>;

  try {
    result = await emulateMessageToEvent(client, input.boc);
  } catch (error) {
    // `Cell.fromBase64` throws synchronously for an unparseable BOC. We
    // surface this as `TRANSACTION_MALFORMED_MESSAGE` reusing the M1.5
    // rule, with the parse error in evidence. Avoids a new rule for what
    // is structurally the same defect: caller-supplied bytes that don't
    // parse.
    return {
      findings: [
        createFinding({
          confidence: "high",
          evidence: {
            source: "boc_parse",
            reason: error instanceof Error ? error.message : String(error),
          },
          rule: getCoreRule("TRANSACTION_MALFORMED_MESSAGE"),
        }),
      ],
      actions: [],
    };
  }

  if (result.status === "skipped") {
    // `reason: "not_configured"` is the only skip reason events-emulate
    // can return (the other skip causes are wallet-emulate-specific). We
    // already checked `client.enabled` above; this branch is defensive.
    return {
      findings: [
        createFinding({
          confidence: "low",
          evidence: {},
          rule: getCoreRule("EMULATION_NOT_CONFIGURED"),
        }),
      ],
      actions: [],
    };
  }

  if (result.status === "failed") {
    return {
      findings: [providerFailureFinding(result)],
      actions: [],
    };
  }

  return mapOkResult(result);
};

// ── result mapping ──────────────────────────────────────────────────────────

const mapOkResult = (result: EventsEmulateOk): BocScanResult => {
  const findings: RiskFinding[] = [];
  const actions = result.actions.map(toActionPreview);

  if (result.trace.isScam) {
    findings.push(
      createFinding({
        confidence: "medium",
        evidence: { source: "events_emulate" },
        rule: getCoreRule("EMULATION_SCAM_PATTERN_DETECTED"),
      }),
    );
  }

  // Wallet V5 auth changes are critical regardless of input shape. The
  // signal is purely per-action — independent of static-vs-emulated diffing
  // and the risk object — so it transfers cleanly to the BOC path. One
  // finding per occurrence keeps evidence inspectable.
  for (const action of result.actions) {
    if (isWalletAuthChangeKind(action.kind)) {
      findings.push(
        createFinding({
          confidence: "high",
          evidence: {
            kind: action.kind,
            rawType: action.rawType,
            source: "events_emulate",
            simplePreview: action.simplePreview,
          },
          rule: getCoreRule("EMULATION_WALLET_V5_AUTH_CHANGE"),
        }),
      );
    }
  }

  return { findings, actions };
};

const isWalletAuthChangeKind = (kind: EmulatedActionKind): boolean =>
  kind === "add_extension" || kind === "remove_extension" || kind === "set_signature_allowed";

/**
 * Action preview mapping for the BOC path. Mirrors the structure used by
 * `emulation-scanner.ts` but is intentionally not shared: keeping the BOC
 * path's emission set tightly scoped to "what we can honestly say about a
 * raw BOC" is easier to enforce when the rendering helpers live alongside
 * the scanner that owns the contract.
 */
const toActionPreview = (action: EmulatedAction): ActionPreview => ({
  kind: mapEmulatedKindToActionKind(action.kind),
  title: actionTitleFor(action),
  description: action.simplePreview,
  assetDeltas: [],
});

const actionTitleFor = (action: EmulatedAction): string => {
  switch (action.kind) {
    case "ton_transfer":
    case "extra_currency_transfer":
      return "Send TON (emulated)";
    case "jetton_transfer":
    case "flawed_jetton_transfer":
    case "jetton_burn":
    case "jetton_mint":
      return "Jetton operation (emulated)";
    case "jetton_swap":
      return "Jetton swap (emulated)";
    case "nft_transfer":
    case "nft_purchase":
    case "auction_bid":
      return "NFT operation (emulated)";
    case "contract_deploy":
      return "Deploy contract (emulated)";
    case "add_extension":
      return "⚠ Add wallet extension (emulated)";
    case "remove_extension":
      return "⚠ Remove wallet extension (emulated)";
    case "set_signature_allowed":
      return "⚠ Change signature auth (emulated)";
    case "smart_contract_exec":
    case "subscribe":
    case "unsubscribe":
    case "deposit_stake":
    case "withdraw_stake":
    case "withdraw_stake_request":
    case "elections_deposit_stake":
    case "elections_recover_stake":
    case "deposit_token_stake":
    case "withdraw_token_stake_request":
    case "liquidity_deposit":
    case "domain_renew":
    case "purchase":
    case "gas_relay":
    case "unknown":
      return `${action.rawType} (emulated)`;
  }
};

const mapEmulatedKindToActionKind = (kind: EmulatedActionKind): ActionPreview["kind"] => {
  switch (kind) {
    case "ton_transfer":
    case "extra_currency_transfer":
      return "send_ton";
    case "jetton_transfer":
    case "flawed_jetton_transfer":
    case "jetton_burn":
    case "jetton_mint":
    case "jetton_swap":
      return "send_jetton";
    case "nft_transfer":
    case "nft_purchase":
    case "auction_bid":
      return "send_nft";
    case "contract_deploy":
      return "deploy_contract";
    case "add_extension":
    case "remove_extension":
    case "set_signature_allowed":
      return "change_wallet_permission";
    case "smart_contract_exec":
    case "subscribe":
    case "unsubscribe":
    case "deposit_stake":
    case "withdraw_stake":
    case "withdraw_stake_request":
    case "elections_deposit_stake":
    case "elections_recover_stake":
    case "deposit_token_stake":
    case "withdraw_token_stake_request":
    case "liquidity_deposit":
    case "domain_renew":
    case "purchase":
    case "gas_relay":
    case "unknown":
      return "unknown";
  }
};

// ── provider-failure classification (shared shape with PR-D1) ───────────────

/**
 * Mirrors `providerFailureFinding` from `emulation-scanner.ts` for the
 * events-emulate path. Kept inline rather than shared because the helper is
 * small and exporting it would couple two otherwise-independent scanners
 * via an internal helper module. Same classification table as PR-D1, same
 * evidence shape so downstream consumers can render either failure source
 * identically.
 */
const providerFailureFinding = (result: {
  readonly reason: "rate_limited" | "provider_down" | "bad_request" | "unknown";
  readonly httpStatus: number | null;
}): RiskFinding => {
  const ruleId = classifyProviderFailure(result.httpStatus, result.reason);

  return createFinding({
    confidence: "low",
    evidence: {
      source: "events_emulate_call",
      httpStatus: result.httpStatus,
      reason: result.reason,
    },
    rule: getCoreRule(ruleId),
  });
};

const classifyProviderFailure = (
  httpStatus: number | null,
  reason: "rate_limited" | "provider_down" | "bad_request" | "unknown",
): "EMULATION_RATE_LIMITED" | "EMULATION_PROVIDER_DOWN" | "EMULATION_FAILED" => {
  if (reason === "rate_limited") {
    return "EMULATION_RATE_LIMITED";
  }

  if (reason === "provider_down") {
    return "EMULATION_PROVIDER_DOWN";
  }

  if (reason === "bad_request") {
    return "EMULATION_FAILED";
  }

  if (httpStatus === 429) {
    return "EMULATION_RATE_LIMITED";
  }

  if (httpStatus === null || httpStatus >= 500) {
    return "EMULATION_PROVIDER_DOWN";
  }

  return "EMULATION_FAILED";
};
