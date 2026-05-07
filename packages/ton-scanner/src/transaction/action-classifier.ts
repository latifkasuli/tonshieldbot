import { assertNever } from "@tonshield/shared";
import type { ActionKind, ActionPreview, AssetDelta } from "@tonshield/shared";
import type { DecodedPayload, ParsedMessage } from "./types.ts";

const NANO = 1_000_000_000n;

/**
 * Converts a nanoton bigint to a plain decimal string without a unit suffix.
 * Used for `AssetDelta.amount` so consumers can combine it with `symbol` freely.
 * Example: 1_500_000_000n → "1.5"
 */
const nanoToDecimal = (nanoTon: bigint): string => {
  const abs = nanoTon < 0n ? -nanoTon : nanoTon;
  const sign = nanoTon < 0n ? "-" : "";
  const intPart = abs / NANO;
  const fracPart = abs % NANO;

  if (fracPart === 0n) {
    return `${sign}${String(intPart)}`;
  }

  const fracStr = String(fracPart).padStart(9, "0").replace(/0+$/, "");

  return `${sign}${String(intPart)}.${fracStr}`;
};

/**
 * Formats a nanoton value as a human-readable string with unit, e.g. "1.5 TON".
 * Use this in descriptions and titles. Use `nanoToDecimal` for `AssetDelta.amount`.
 */
export const formatNano = (nanoTon: bigint): string => `${nanoToDecimal(nanoTon)} TON`;

export const shortenAddress = (address: string): string => {
  if (address.length <= 12) {
    return address;
  }

  return `${address.slice(0, 6)}…${address.slice(-4)}`;
};

const buildTonDelta = (
  value: bigint,
  direction: AssetDelta["direction"],
  to: string | null,
  from: string | null,
): AssetDelta => ({
  assetType: "ton",
  direction,
  // Decimal string without unit — consumers combine with symbol: "TON" themselves
  amount: nanoToDecimal(value),
  symbol: "TON",
  to,
  from,
});

const classifyPayload = (
  payload: DecodedPayload,
  msg: ParsedMessage,
): { kind: ActionKind; title: string; description: string; assetDeltas: readonly AssetDelta[] } => {
  switch (payload.kind) {
    case "none":
      return {
        kind: "send_ton",
        title: "Send TON",
        description: `Send ${formatNano(msg.value)} to ${shortenAddress(msg.to)}`,
        assetDeltas: [buildTonDelta(msg.value, "outgoing", msg.to, null)],
      };

    case "ton_comment": {
      const comment =
        payload.text.length > 0
          ? ` — "${payload.text.slice(0, 60)}${payload.text.length > 60 ? "…" : ""}"`
          : "";

      return {
        kind: "send_ton",
        title: "Send TON with comment",
        description: `Send ${formatNano(msg.value)} to ${shortenAddress(msg.to)}${comment}`,
        assetDeltas: [buildTonDelta(msg.value, "outgoing", msg.to, null)],
      };
    }

    case "jetton_transfer":
      return {
        kind: "send_jetton",
        title: "Send Jetton",
        description: `Transfer Jetton to ${shortenAddress(payload.destination)}`,
        assetDeltas: [
          {
            assetType: "jetton",
            direction: "outgoing",
            amount: String(payload.amount),
            symbol: null,
            to: payload.destination,
            from: null,
          },
          ...(msg.value > 0n
            ? [buildTonDelta(msg.value, "outgoing", msg.to, null)]
            : ([] as AssetDelta[])),
        ],
      };

    case "nft_transfer":
      return {
        kind: "send_nft",
        title: "Send NFT",
        description: `Transfer NFT to ${shortenAddress(payload.newOwner)}`,
        assetDeltas: [
          {
            assetType: "nft",
            direction: "outgoing",
            amount: null,
            symbol: null,
            to: payload.newOwner,
            from: null,
          },
          ...(msg.value > 0n
            ? [buildTonDelta(msg.value, "outgoing", msg.to, null)]
            : ([] as AssetDelta[])),
        ],
      };

    case "opaque": {
      const opHex =
        payload.opCode !== null ? `0x${payload.opCode.toString(16).padStart(8, "0")}` : "unknown";

      return {
        kind: "unknown",
        title: "Unknown contract call",
        description: `Contract call with op code ${opHex} to ${shortenAddress(msg.to)}`,
        assetDeltas: [buildTonDelta(msg.value, "outgoing", msg.to, null)],
      };
    }

    default:
      return assertNever(payload);
  }
};

export const classifyMessage = (msg: ParsedMessage): ActionPreview => {
  if (msg.hasStateInit) {
    return {
      kind: "deploy_contract",
      title: "Deploy contract",
      description: `Deploy a new contract to ${shortenAddress(msg.to)}`,
      assetDeltas: [buildTonDelta(msg.value, "outgoing", msg.to, null)],
    };
  }

  const { kind, title, description, assetDeltas } = classifyPayload(msg.payload, msg);

  return { kind, title, description, assetDeltas };
};
