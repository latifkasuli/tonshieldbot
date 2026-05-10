/**
 * High-level wrapper around `POST /v2/wallet/emulate`. Owns:
 *
 *   1. The `client.enabled` short-circuit (returns `skipped: not_configured`
 *      so the scanner can surface `EMULATION_NOT_CONFIGURED` without doing
 *      its own check).
 *   2. The actual SDK call.
 *   3. Mapping the SDK's `MessageConsequences` shape into our narrowed
 *      `EmulationResult` so the scanner stays free of TONAPI-specific types.
 *
 * Provider failure modes (HTTP 4xx, 5xx, network errors) map to
 * `failed: { reason }`. PR-D refines the exact reason classification; PR-C
 * just needs the typed boundary so the scanner can degrade gracefully.
 */
import { Cell } from "@ton/core";
import type { Action, Event, MessageConsequences, Risk } from "@ton-api/client";
import type { TonEmulatorClient } from "./client.ts";
import {
  type EmulatedAction,
  type EmulatedActionDetails,
  type EmulatedActionKind,
  type EmulatedRisk,
  type EventsEmulationResult,
  type FailedResult,
  type WalletEmulationResult,
  emulatedActionKinds,
} from "./types.ts";

export const emulateMessageToWallet = async (
  client: TonEmulatorClient,
  boc: string,
): Promise<WalletEmulationResult> => {
  if (!client.enabled) {
    return { status: "skipped", reason: "not_configured" };
  }

  // The SDK takes `boc: Cell`. Our public surface accepts a base64 string to
  // match the OpenAPI body shape and keep the request builder's output usable
  // unchanged. Convert at the boundary; an unparseable BOC is the caller's
  // bug and surfaces as a thrown error rather than a graceful failure.
  const bocCell = Cell.fromBase64(boc);
  let response: MessageConsequences;

  try {
    response = await client.raw.emulation.emulateMessageToWallet({ boc: bocCell });
  } catch (error) {
    return classifyFailure(error);
  }

  return {
    status: "ok",
    source: "wallet_emulate",
    actions: response.event.actions.map(toEmulatedAction),
    risk: toEmulatedRisk(response.risk),
    trace: {
      // Read `aborted` directly from the SDK shape rather than inferring it
      // from `!success`. The two flags are semantically distinct in TVM:
      // `success` reflects overall outcome (a bounce can leave it true),
      // while `aborted` is the canonical compute-phase failure flag and is
      // what the EMULATION_ABORTED rule is documented against in spec §9.3.3.
      aborted: response.trace.transaction.aborted,
      isScam: response.event.isScam,
    },
  };
};

/**
 * High-level wrapper around `POST /v2/events/emulate`. Used as a fallback
 * when the caller has a raw BOC but no way to wrap it as an authenticated
 * wallet message — see `scanBocWithEmulation` in `@tonshield/ton-scanner`.
 *
 * Key contract differences from `emulateMessageToWallet`:
 *
 *   - Returns `source: "events_emulate"`, narrowing `risk` to `null` and
 *     `trace.aborted` to `null` in the result type. Callers MUST NOT emit
 *     `EMULATION_SENDS_NEAR_FULL_BALANCE` or `EMULATION_ABORTED` on this
 *     path — TypeScript enforces that those fields cannot be read without
 *     branching on `source`.
 *   - Empirically (verified via the `.smoke/endpoint-shapes.mts` probe),
 *     `/v2/events/emulate` is permissive about the BOC's signature for
 *     wallet senders — no `ignore_signature_check=true` parameter is needed
 *     even for dummy-signed messages. The SDK call below relies on that.
 *
 * Failure and skip classification is shared with `emulateMessageToWallet`
 * via `classifyFailure`. Errors from this endpoint should be presented to
 * users with identical degradation findings (EMULATION_RATE_LIMITED,
 * EMULATION_PROVIDER_DOWN, EMULATION_FAILED) per PR-D1.
 */
export const emulateMessageToEvent = async (
  client: TonEmulatorClient,
  boc: string,
): Promise<EventsEmulationResult> => {
  if (!client.enabled) {
    return { status: "skipped", reason: "not_configured" };
  }

  const bocCell = Cell.fromBase64(boc);
  let response: Event;

  try {
    response = await client.raw.emulation.emulateMessageToEvent({ boc: bocCell });
  } catch (error) {
    return classifyFailure(error);
  }

  return {
    status: "ok",
    source: "events_emulate",
    actions: response.actions.map(toEmulatedAction),
    // /v2/events/emulate does not return a pre-computed risk summary.
    // We deliberately do NOT derive one from valueFlow — that would be a
    // different (and lower-fidelity) signal than wallet/emulate's risk and
    // would invite consumers to treat the two as interchangeable.
    risk: null,
    trace: {
      // No trace shape from this endpoint. Pinning `aborted` to null in the
      // type ensures consumers can't conflate it with a confirmed `false`.
      aborted: null,
      isScam: response.isScam,
    },
  };
};

/**
 * Maps SDK `Action.type` strings to our `EmulatedActionKind` enum.
 *
 * Note: the SDK's `Action.type` union is a strict subset of what TONAPI
 * actually returns at runtime — the SDK at `@ton-api/client@0.4.0` predates
 * the addition of `AddExtension`, `RemoveExtension`,
 * `SetSignatureAllowedAction`, `Purchase`, `LiquidityDeposit`, and the token-
 * stake variants. Those still arrive as strings on the wire and we MUST handle
 * them, so the mapping reads `action.type` as a plain string and treats the
 * SDK's narrow type as advisory only.
 */
const ACTION_KIND_MAP: Readonly<Record<string, EmulatedActionKind>> = {
  TonTransfer: "ton_transfer",
  ExtraCurrencyTransfer: "extra_currency_transfer",
  JettonTransfer: "jetton_transfer",
  FlawedJettonTransfer: "flawed_jetton_transfer",
  JettonBurn: "jetton_burn",
  JettonMint: "jetton_mint",
  JettonSwap: "jetton_swap",
  NftItemTransfer: "nft_transfer",
  NftPurchase: "nft_purchase",
  AuctionBid: "auction_bid",
  ContractDeploy: "contract_deploy",
  SmartContractExec: "smart_contract_exec",
  Subscribe: "subscribe",
  UnSubscribe: "unsubscribe",
  DepositStake: "deposit_stake",
  WithdrawStake: "withdraw_stake",
  WithdrawStakeRequest: "withdraw_stake_request",
  ElectionsDepositStake: "elections_deposit_stake",
  ElectionsRecoverStake: "elections_recover_stake",
  DepositTokenStake: "deposit_token_stake",
  WithdrawTokenStakeRequest: "withdraw_token_stake_request",
  LiquidityDeposit: "liquidity_deposit",
  DomainRenew: "domain_renew",
  Purchase: "purchase",
  AddExtension: "add_extension",
  RemoveExtension: "remove_extension",
  SetSignatureAllowedAction: "set_signature_allowed",
  GasRelay: "gas_relay",
  Unknown: "unknown",
};

const toEmulatedAction = (action: Action): EmulatedAction => {
  const rawType = action.type as string;
  const kind = ACTION_KIND_MAP[rawType] ?? "unknown";

  // Belt and braces: ensure whatever we put on `kind` is in our enum, even
  // after a future SDK upgrade adds an unmapped type. Keeps downstream
  // exhaustive switches honest.
  const safeKind: EmulatedActionKind = (emulatedActionKinds as readonly string[]).includes(kind)
    ? kind
    : "unknown";

  return {
    kind: safeKind,
    status: action.status,
    simplePreview: action.simplePreview.description,
    rawType,
    details: extractDetails(action),
  };
};

/**
 * Extracts structured per-kind fields from TONAPI's typed action subobjects.
 * Returns `null` for kinds not in PR-D2's deterministic-diff scope.
 *
 * The check is double-keyed (`action.type === "..."` AND the subobject is
 * present) because TONAPI populates only the subobject matching the action
 * type — reading the wrong one would yield `undefined`. We never fall back
 * to `simplePreview` parsing; that text is for display, not for diff logic.
 */
const extractDetails = (action: Action): EmulatedActionDetails | null => {
  if (action.type === "TonTransfer" && action.TonTransfer !== undefined) {
    return {
      kind: "ton_transfer",
      recipient: action.TonTransfer.recipient.address.toRawString(),
      amountNano: action.TonTransfer.amount,
    };
  }

  if (action.type === "ContractDeploy" && action.ContractDeploy !== undefined) {
    return {
      kind: "contract_deploy",
      address: action.ContractDeploy.address.toRawString(),
      interfaces: action.ContractDeploy.interfaces,
    };
  }

  return null;
};

const toEmulatedRisk = (risk: Risk): EmulatedRisk => ({
  transferAllRemainingBalance: risk.transferAllRemainingBalance,
  tonNano: risk.ton,
  jettons: risk.jettons.map((entry) => ({
    masterAddress: entry.jetton.address.toString(),
    amount: entry.quantity,
    symbol: entry.jetton.symbol,
  })),
  nfts: risk.nfts.map((nft) => ({
    address: nft.address.toString(),
    collectionAddress: nft.collection?.address.toString() ?? null,
  })),
  // SDK 0.4.0 doesn't surface total_equivalent. Newer TONAPI does — we'll
  // pick it up automatically once the SDK upgrades by reading from a fallback
  // index. For now we report null and rely on per-asset fields.
  totalEquivalentUsd:
    typeof (risk as Risk & { totalEquivalent?: number }).totalEquivalent === "number"
      ? (risk as Risk & { totalEquivalent: number }).totalEquivalent
      : null,
});

const classifyFailure = (error: unknown): FailedResult => {
  const httpStatus = extractHttpStatus(error);

  if (httpStatus === null) {
    return { status: "failed", reason: "provider_down", httpStatus: null };
  }

  if (httpStatus === 429) {
    return { status: "failed", reason: "rate_limited", httpStatus };
  }

  if (httpStatus >= 500) {
    return { status: "failed", reason: "provider_down", httpStatus };
  }

  if (httpStatus >= 400) {
    return { status: "failed", reason: "bad_request", httpStatus };
  }

  return { status: "failed", reason: "unknown", httpStatus };
};

const extractHttpStatus = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const candidate = (error as { status?: unknown }).status;

  return typeof candidate === "number" ? candidate : null;
};
