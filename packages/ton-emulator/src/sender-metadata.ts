import { Address } from "@ton/core";
import { AccountStatus } from "@ton-api/client";
import type { TonEmulatorClient } from "./client.ts";
import { networkGlobalIds, type NetworkGlobalId } from "./request-builder.ts";
import type { WalletVersion } from "./types.ts";

export interface SenderMetadata {
  readonly walletVersion: WalletVersion;
  readonly publicKey: Buffer;
  readonly seqno: number;
  readonly networkGlobalId: NetworkGlobalId;
  /** True when the sender's account exists on-chain with non-empty state. */
  readonly exists: boolean;
}

export type SenderMetadataResult =
  | { readonly status: "ok"; readonly metadata: SenderMetadata }
  | { readonly status: "uninitialised" }
  | { readonly status: "unknown_wallet"; readonly interfaces: readonly string[] }
  | { readonly status: "fetch_failed"; readonly httpStatus: number | null };

/**
 * Maps TONAPI account `interfaces[]` strings to our `WalletVersion` enum.
 *
 * TONAPI labels every account it recognises with an `interfaces[]` list (the
 * same data you see in Tonviewer's "Type"). We recognise the three wallet
 * versions our emulator supports and treat everything else as `unknown` so the
 * scanner can fall back to static-only mode rather than guessing.
 */
const detectWalletVersion = (interfaces: readonly string[]): WalletVersion => {
  const lower = new Set(interfaces.map((iface) => iface.toLowerCase()));

  // V5R1 first — its detection string varies between `wallet_v5r1` and
  // `wallet_v5_r1` across TONAPI versions, so we accept either.
  if (lower.has("wallet_v5r1") || lower.has("wallet_v5_r1")) {
    return "v5r1";
  }

  if (lower.has("wallet_v4r2")) {
    return "v4r2";
  }

  if (lower.has("wallet_v3r2")) {
    return "v3r2";
  }

  return "unknown";
};

/**
 * Maps the configured TONAPI base URL to a network global ID. Mainnet is
 * `https://tonapi.io`, testnet is `https://testnet.tonapi.io`. Anything else
 * defaults to mainnet — a misconfigured base URL surfaces elsewhere.
 */
const networkFromBaseUrl = (baseUrl: string): NetworkGlobalId =>
  baseUrl.toLowerCase().includes("testnet") ? networkGlobalIds.testnet : networkGlobalIds.mainnet;

/**
 * Fetches the three pieces of state the request builder needs from TONAPI:
 *   - The wallet's current `seqno`
 *   - The wallet's on-chain public key (as a hex string from TONAPI; we
 *     return it as a Buffer)
 *   - The wallet contract version, derived from the account's `interfaces[]`
 *
 * Failure modes intentionally surface as a discriminated union rather than
 * throwing, so the caller can convert each one into the right `EMULATION_*`
 * finding (see spec §9.3.5):
 *
 *   - `uninitialised` → `EMULATION_SENDER_UNINITIALISED` (info)
 *   - `unknown_wallet` → skip emulation, evidence carries `interfaces[]`
 *   - `fetch_failed` → either `EMULATION_FAILED` (4xx) or
 *     `EMULATION_PROVIDER_DOWN` (5xx / network)
 */
export const fetchSenderMetadata = async (
  client: TonEmulatorClient,
  senderAddress: Address,
): Promise<SenderMetadataResult> => {
  if (!client.enabled) {
    // Defensive — callers should branch on `client.enabled` first; we still
    // return a typed result rather than throwing if they don't.
    return { status: "fetch_failed", httpStatus: null };
  }

  try {
    const account = await client.raw.accounts.getAccount(senderAddress);

    // `Uninit` means the address is known but never received its first
    // inbound message; `Nonexist` means TONAPI has no record at all; `Frozen`
    // means the account ran out of storage funds and is suspended. None of
    // these can execute, so all three are equivalent for our purposes —
    // emulation cannot run because there is no live contract.
    if (account.status !== AccountStatus.Active) {
      return { status: "uninitialised" };
    }

    const interfaces = account.interfaces ?? [];
    const walletVersion = detectWalletVersion(interfaces);

    if (walletVersion === "unknown") {
      return { status: "unknown_wallet", interfaces };
    }

    const [seqnoResponse, publicKeyResponse] = await Promise.all([
      client.raw.wallet.getAccountSeqno(senderAddress),
      client.raw.accounts.getAccountPublicKey(senderAddress),
    ]);

    return {
      status: "ok",
      metadata: {
        walletVersion,
        publicKey: Buffer.from(publicKeyResponse.publicKey, "hex"),
        seqno: seqnoResponse.seqno,
        networkGlobalId: networkFromBaseUrl(client.baseUrl),
        exists: true,
      },
    };
  } catch (error) {
    return { status: "fetch_failed", httpStatus: extractHttpStatus(error) };
  }
};

/**
 * Recovers the HTTP status code from `@ton-api/client` errors when present.
 * The SDK wraps fetch failures in its own error type; we narrow to the field
 * we care about without taking a hard dependency on the error class shape.
 */
const extractHttpStatus = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const candidate = (error as { status?: unknown }).status;

  return typeof candidate === "number" ? candidate : null;
};
