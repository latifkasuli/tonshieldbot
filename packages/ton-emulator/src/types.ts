/**
 * TS shapes for the slice of TONAPI responses TON Shield consumes. Mirrors the
 * authoritative OpenAPI schema at
 * https://github.com/tonkeeper/tonapi-go/blob/main/api/openapi.yml — keep this
 * narrow and only model fields the scanner actually reads.
 *
 * The full SDK (`@ton-api/client`) returns much richer typed objects; we
 * re-shape into these to keep the surface stable across SDK versions and to
 * keep the rest of the codebase free of TONAPI-specific types.
 */

/** Wallet contract version detected from `interfaces[]` on the sender account. */
export const walletVersions = ["v3r2", "v4r2", "v5r1", "unknown"] as const;
export type WalletVersion = (typeof walletVersions)[number];

/**
 * Per-action kinds mirrored 1:1 from TONAPI v2 `Action.type`. Source of truth:
 * https://github.com/tonkeeper/tonapi-go/blob/main/api/openapi.yml (search for
 * `Action:` schema).
 *
 * Keep this list complete: TONAPI emits one of these strings, and downstream
 * exhaustive switches (`assertNever`) rely on the union covering every
 * possibility. Missing values land as `"unknown"` at the mapping boundary,
 * not silently as `undefined`.
 */
export const emulatedActionKinds = [
  "ton_transfer",
  "extra_currency_transfer",
  "jetton_transfer",
  "flawed_jetton_transfer",
  "jetton_burn",
  "jetton_mint",
  "jetton_swap",
  "nft_transfer",
  "nft_purchase",
  "auction_bid",
  "contract_deploy",
  "smart_contract_exec",
  "subscribe",
  "unsubscribe",
  "deposit_stake",
  "withdraw_stake",
  "withdraw_stake_request",
  "elections_deposit_stake",
  "elections_recover_stake",
  "deposit_token_stake",
  "withdraw_token_stake_request",
  "liquidity_deposit",
  "domain_renew",
  "purchase",
  "add_extension",
  "remove_extension",
  "set_signature_allowed",
  "gas_relay",
  "unknown",
] as const;
export type EmulatedActionKind = (typeof emulatedActionKinds)[number];

/**
 * Conservative upper bound on assets that may leave the wallet if the
 * emulated message is sent and counterparties behave maliciously. Mirrors
 * `MessageConsequences.risk` from TONAPI v2. Drives several M2 findings —
 * notably `EMULATION_SENDS_NEAR_FULL_BALANCE` (when `transferAllRemainingBalance` is
 * true).
 */
export interface EmulatedRisk {
  /** Drainer-pattern signal: message can sweep all current/future TON balance. */
  readonly transferAllRemainingBalance: boolean;
  /** Maximum nanoton outflow in the worst case. */
  readonly tonNano: bigint;
  /** Jetton positions at risk. Master address + raw amount (decimals not applied). */
  readonly jettons: readonly {
    readonly masterAddress: string;
    readonly amount: bigint;
    readonly symbol: string | null;
  }[];
  /** NFT items that may be transferred out. */
  readonly nfts: readonly {
    readonly address: string;
    readonly collectionAddress: string | null;
  }[];
  /** Approximate USD-equivalent of all assets at risk. UI-only. */
  readonly totalEquivalentUsd: number | null;
}

/**
 * Structured per-kind details lifted directly from TONAPI's typed action
 * subobjects (`Action.TonTransfer`, `Action.ContractDeploy`, …). Populated
 * ONLY for kinds the diff module compares against the static decode; for all
 * other kinds this is `null` and the diff module ignores the action.
 *
 * The contract here is explicit: no human-readable text is ever pulled from
 * `simplePreview` to populate these fields. Everything comes from TONAPI's
 * structured response. Adding more kinds (jetton, NFT, …) is intentional
 * future work — those operations have layering between static payload
 * semantics and emulated effect that a naive 1:1 diff would over-flag.
 *
 * Addresses are stored as raw `"0:hex"` form (via `Address.toRawString()`)
 * so equality comparisons across friendly/raw input forms are exact.
 */
export type EmulatedActionDetails =
  | {
      readonly kind: "ton_transfer";
      /** Recipient address in raw `"0:hex"` form. */
      readonly recipient: string;
      /** Amount in nanotons, as TONAPI reported it. */
      readonly amountNano: bigint;
    }
  | {
      readonly kind: "contract_deploy";
      /** Address of the newly-deployed contract, in raw `"0:hex"` form. */
      readonly address: string;
      /** TONAPI-detected interfaces on the deployed code. */
      readonly interfaces: readonly string[];
    };

/** A single high-level action TONAPI extracted from the emulated trace. */
export interface EmulatedAction {
  readonly kind: EmulatedActionKind;
  /** TONAPI's own `Action.status`. `failed` means the sub-transaction aborted. */
  readonly status: "ok" | "failed";
  /** Human-readable summary TONAPI generated. */
  readonly simplePreview: string;
  /** The raw `Action.type` string, preserved verbatim for evidence/debugging. */
  readonly rawType: string;
  /**
   * Structured fields for kinds the diff module compares deterministically.
   * `null` for kinds not yet in scope (jetton, NFT, swap, stake, …).
   */
  readonly details: EmulatedActionDetails | null;
}

/**
 * The result we hand to the scanner. Distilled from one of the two TONAPI
 * emulation endpoints we call:
 *
 *   - `/v2/wallet/emulate` returns `MessageConsequences { trace, risk, event }`.
 *     We expose this as the `wallet_emulate` `ok` variant — full fidelity
 *     including `risk.transferAllRemainingBalance` and `trace.aborted`.
 *   - `/v2/events/emulate` returns `Event { actions, valueFlow, isScam, … }`.
 *     We expose this as the `events_emulate` `ok` variant. There is NO
 *     `risk` object and NO trace shape on this endpoint — those fields are
 *     pinned to `null` in the type so consumers can't accidentally read them.
 *
 * The two `ok` variants share the same `actions[]` shape, so downstream code
 * that only consumes actions (the diff module, action-preview rendering)
 * works against either without branching. Consumers that read `risk` or
 * `trace.aborted` MUST narrow on `source` first; TypeScript enforces this.
 *
 * Failure and skip variants are endpoint-agnostic and unchanged from PR-D1.
 */
export type EmulationResult = WalletEmulateOk | EventsEmulateOk | SkippedResult | FailedResult;

/**
 * Endpoint-agnostic "did not emulate" result. Used by both wallet and events
 * paths; the `reason` enum covers all skip causes either path can produce.
 */
export interface SkippedResult {
  readonly status: "skipped";
  readonly reason:
    | "not_configured"
    | "no_sender"
    | "sender_uninitialised"
    | "unknown_wallet_contract";
}

/**
 * Endpoint-agnostic provider-failure result. Shared classification with PR-D1.
 */
export interface FailedResult {
  readonly status: "failed";
  readonly reason: "rate_limited" | "provider_down" | "bad_request" | "unknown";
  readonly httpStatus: number | null;
}

/**
 * Tighter return type for `emulateMessageToWallet`. Excludes the events-emulate
 * variant so callers can hand the OK case directly to wallet-only consumers
 * without re-narrowing on `source`.
 */
export type WalletEmulationResult = WalletEmulateOk | SkippedResult | FailedResult;

/**
 * Tighter return type for `emulateMessageToEvent`. Mirror of the above for
 * the events-emulate path.
 */
export type EventsEmulationResult = EventsEmulateOk | SkippedResult | FailedResult;

/**
 * Successful `/v2/wallet/emulate` response. Carries the full
 * `MessageConsequences` shape — pre-computed `risk` and a trace with the
 * canonical `aborted` flag.
 */
export interface WalletEmulateOk {
  readonly status: "ok";
  readonly source: "wallet_emulate";
  readonly actions: readonly EmulatedAction[];
  readonly risk: EmulatedRisk;
  readonly trace: {
    /** True when the root transaction aborted. */
    readonly aborted: boolean;
    /** TONAPI's `is_scam` flag on the resulting account event. */
    readonly isScam: boolean;
  };
}

/**
 * Successful `/v2/events/emulate` response. Used for raw-BOC inputs where
 * we don't have a wallet-typed envelope to give to wallet/emulate. TONAPI
 * does not return a `risk` object or a trace on this endpoint, so:
 *
 *   - `risk` is `null` (callers must NOT emit `EMULATION_SENDS_NEAR_FULL_BALANCE`
 *     — we don't compute the pre-computed risk summary ourselves)
 *   - `trace.aborted` is `null` (callers must NOT emit `EMULATION_ABORTED` —
 *     we'd be inventing a definition; the events response has no honest
 *     source for it)
 *   - `trace.isScam` IS available — the events response includes the
 *     `is_scam` flag at top level, so `EMULATION_SCAM_PATTERN_DETECTED` is
 *     fair game on this path.
 */
export interface EventsEmulateOk {
  readonly status: "ok";
  readonly source: "events_emulate";
  readonly actions: readonly EmulatedAction[];
  readonly risk: null;
  readonly trace: {
    readonly aborted: null;
    readonly isScam: boolean;
  };
}
