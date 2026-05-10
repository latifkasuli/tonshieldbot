import { Address } from "@ton/core";
import type { EmulatedAction } from "@tonshield/ton-emulator";
import type { ParsedMessage } from "./types.ts";

/**
 * Pure, deterministic comparison of the static decode against the emulated
 * action list. Produces two categories of findings that the caller maps onto
 * `EMULATION_MISMATCH` and `EMULATION_REVEALED_HIDDEN_ACTION`:
 *
 *   - **Mismatches**: a static `send_ton` message and its position-paired
 *     emulated `ton_transfer` action disagree on destination or amount.
 *   - **Hidden actions**: an emulated `ton_transfer` action with no static
 *     counterpart — the dApp's `messages[]` did not declare it.
 *
 * Scope constraint (PR-D2): only kinds we can deterministically compare with
 * confidence are diffed today. That is `ton_transfer` and (negative-side
 * only) `contract_deploy` via the pre-existing `EMULATION_DEPLOYS_UNKNOWN_CONTRACT`
 * rule. Jetton and NFT transfers are explicitly out of scope — the static
 * payload semantics and the emulated downstream effect live at different
 * layers (jetton-master → jetton-wallet → recipient hop, royalty forwards,
 * marketplace fan-out) and a naive 1:1 diff would over-flag.
 *
 * No `simplePreview` text is ever parsed. All comparisons read from
 * structured fields: `ParsedMessage.{to,value}` on the static side and
 * `EmulatedAction.details` on the emulated side.
 *
 * Address comparison: both sides are canonicalised to raw `"0:hex"` form
 * via `Address.parse().toRawString()` so EQ/UQ/0:hex inputs compare equal.
 */

export type DiffMismatch =
  | {
      readonly kind: "ton_transfer_destination";
      /** Index in the original static `messages[]` array. */
      readonly messageIndex: number;
      /** Static destination as the dApp declared it (preserved verbatim). */
      readonly staticDestination: string;
      /** Emulated destination in raw `"0:hex"` form. */
      readonly emulatedDestination: string;
    }
  | {
      readonly kind: "ton_transfer_amount";
      /** Index in the original static `messages[]` array. */
      readonly messageIndex: number;
      /** Destination both sides agreed on (raw `"0:hex"` form). */
      readonly destination: string;
      /** Static amount in nanotons (as a string to keep evidence JSON-safe). */
      readonly staticAmountNano: string;
      /** Emulated amount in nanotons (as a string to keep evidence JSON-safe). */
      readonly emulatedAmountNano: string;
    };

export interface DiffHiddenAction {
  /** Index in the emulated `actions[]` array — for debugging/cross-ref. */
  readonly emulatedActionIndex: number;
  readonly kind: "ton_transfer";
  /** Recipient address in raw `"0:hex"` form. */
  readonly recipient: string;
  /** Amount in nanotons (as a string to keep evidence JSON-safe). */
  readonly amountNano: string;
  /** TONAPI's original `Action.type` string (e.g. "TonTransfer"). */
  readonly rawType: string;
}

export interface DiffResult {
  readonly mismatches: readonly DiffMismatch[];
  readonly hiddenActions: readonly DiffHiddenAction[];
}

/**
 * Determines whether a static `ParsedMessage` is a "comparable TON send" —
 * i.e. a plain TON transfer (possibly with a text comment) that the
 * emulator should emit as a `TonTransfer` action.
 *
 * Deploys (any payload + stateInit), Jetton transfers, NFT transfers, and
 * opaque contract calls are excluded — their emulated counterparts live in
 * different action types (`ContractDeploy`, `JettonTransfer`, `NftItemTransfer`,
 * `SmartContractExec`) and are intentionally out of PR-D2's diff scope.
 */
const isComparableTonSend = (message: ParsedMessage): boolean => {
  if (message.hasStateInit) {
    return false;
  }

  return message.payload.kind === "none" || message.payload.kind === "ton_comment";
};

const isTonTransferEmulatedAction = (
  action: EmulatedAction,
): action is EmulatedAction & {
  details: { kind: "ton_transfer"; recipient: string; amountNano: bigint };
} => action.kind === "ton_transfer" && action.details?.kind === "ton_transfer";

/**
 * Canonicalises a static-side address string (which may be EQ/UQ friendly
 * or raw `"0:hex"`) to raw form for comparison. Returns `null` if parsing
 * fails — the diff module then skips the comparison rather than emitting a
 * misleading mismatch from an unparseable static destination.
 */
const canonicalAddress = (raw: string): string | null => {
  try {
    return Address.parse(raw).toRawString();
  } catch {
    return null;
  }
};

export const diffStaticVsEmulated = (input: {
  readonly staticMessages: readonly ParsedMessage[];
  readonly emulatedActions: readonly EmulatedAction[];
}): DiffResult => {
  // Pair by position WITHIN each side's filtered subsequence. We filter both
  // sides down to "comparable TON sends" / "ton_transfer emulated actions"
  // and then walk them index-aligned. This is robust to extra unrelated
  // actions on either side (e.g. an emulated SmartContractExec interleaved
  // with TonTransfers) and avoids false-pairing across types.
  const comparableStatics = input.staticMessages
    .map((message, originalIndex) => ({ message, originalIndex }))
    .filter((entry) => isComparableTonSend(entry.message));

  const comparableEmulated = input.emulatedActions
    .map((action, originalIndex) => ({ action, originalIndex }))
    .filter((entry) => isTonTransferEmulatedAction(entry.action));

  const mismatches: DiffMismatch[] = [];
  const hiddenActions: DiffHiddenAction[] = [];

  const pairCount = Math.max(comparableStatics.length, comparableEmulated.length);

  for (let i = 0; i < pairCount; i += 1) {
    const staticEntry = comparableStatics[i];
    const emulatedEntry = comparableEmulated[i];

    if (staticEntry === undefined && emulatedEntry !== undefined) {
      // Extra emulated TonTransfer with no static counterpart → hidden.
      // This is the high-signal case: the dApp's signed `messages[]` did
      // not declare this transfer, yet emulation shows it will happen.
      // Common malicious shape: a multisig fan-out that drains to an
      // attacker address while the visible `messages[]` looks benign.
      if (isTonTransferEmulatedAction(emulatedEntry.action)) {
        hiddenActions.push({
          emulatedActionIndex: emulatedEntry.originalIndex,
          kind: "ton_transfer",
          recipient: emulatedEntry.action.details.recipient,
          amountNano: emulatedEntry.action.details.amountNano.toString(),
          rawType: emulatedEntry.action.rawType,
        });
      }
      continue;
    }

    if (staticEntry !== undefined && emulatedEntry === undefined) {
      // Static expected a TON send here but emulator produced no
      // corresponding TonTransfer. This is NOT flagged as a mismatch —
      // TONAPI may have re-classified the action (e.g. as SmartContractExec
      // if the destination is a recognised contract), which is a labelling
      // difference, not a contradiction. Re-classification handling lives
      // in future PRs once we have a confidence model for it.
      continue;
    }

    if (
      staticEntry !== undefined &&
      emulatedEntry !== undefined &&
      isTonTransferEmulatedAction(emulatedEntry.action)
    ) {
      const staticCanonical = canonicalAddress(staticEntry.message.to);

      if (staticCanonical === null) {
        // Static destination unparseable — skip rather than report a
        // mismatch with a meaningless "static value". `parseMessages`
        // already surfaces `TRANSACTION_MALFORMED_MESSAGE` for this case;
        // we don't double-flag it here.
        continue;
      }

      const emulatedCanonical = emulatedEntry.action.details.recipient;

      if (staticCanonical !== emulatedCanonical) {
        mismatches.push({
          kind: "ton_transfer_destination",
          messageIndex: staticEntry.originalIndex,
          staticDestination: staticEntry.message.to,
          emulatedDestination: emulatedCanonical,
        });
        // When the destination disagrees, the amount comparison on the
        // same pair is meaningless (you cannot say "we agreed on amount
        // but to different recipients"). Skip the amount check for this
        // pair to keep evidence focused on the primary defect.
        continue;
      }

      if (staticEntry.message.value !== emulatedEntry.action.details.amountNano) {
        mismatches.push({
          kind: "ton_transfer_amount",
          messageIndex: staticEntry.originalIndex,
          destination: emulatedCanonical,
          staticAmountNano: staticEntry.message.value.toString(),
          emulatedAmountNano: emulatedEntry.action.details.amountNano.toString(),
        });
      }
    }
  }

  return { mismatches, hiddenActions };
};
