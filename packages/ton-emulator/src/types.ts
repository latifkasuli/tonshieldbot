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

/** Per-action kinds we map from TONAPI `Action.type`. Aligned with §9.4 of the spec. */
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
 * notably `TX_SENDS_NEAR_FULL_BALANCE` (when `transferAllRemainingBalance` is
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

/** A single high-level action TONAPI extracted from the emulated trace. */
export interface EmulatedAction {
  readonly kind: EmulatedActionKind;
  /** TONAPI's own `Action.status`. `failed` means the sub-transaction aborted. */
  readonly status: "ok" | "failed";
  /** Human-readable summary TONAPI generated. */
  readonly simplePreview: string;
  /** The raw `Action.type` string, preserved verbatim for evidence/debugging. */
  readonly rawType: string;
}

/**
 * The result we hand to the scanner. Distilled from `MessageConsequences`
 * and from explicit failure/skip paths described in spec §9.3.5.
 */
export type EmulationResult =
  | {
      readonly status: "ok";
      readonly actions: readonly EmulatedAction[];
      readonly risk: EmulatedRisk;
      readonly trace: {
        /** True when the root transaction aborted. */
        readonly aborted: boolean;
        /** TONAPI's `is_scam` flag on the resulting account event. */
        readonly isScam: boolean;
      };
    }
  | {
      readonly status: "skipped";
      readonly reason:
        | "not_configured"
        | "no_sender"
        | "sender_uninitialised"
        | "unknown_wallet_contract";
    }
  | {
      readonly status: "failed";
      readonly reason: "rate_limited" | "provider_down" | "bad_request" | "unknown";
      readonly httpStatus: number | null;
    };
