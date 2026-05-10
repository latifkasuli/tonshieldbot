import {
  Address,
  beginCell,
  Cell,
  external,
  internal,
  loadStateInit,
  type MessageRelaxed,
  SendMode,
  storeMessage,
  type StateInit,
} from "@ton/core";
import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from "@ton/ton";
import { assertNever } from "@tonshield/shared";
import type { WalletVersion } from "./types.ts";

/**
 * The slice of a TON Connect transaction message we need for emulation. Mirrors
 * the public TON Connect SDK shape exactly so callers can pass straight from
 * their parsed JSON without reshaping.
 */
export interface TonConnectMessage {
  /** Destination contract / wallet address (base64 friendly or raw form). */
  readonly address: string;
  /** Nanoton amount as an unsigned integer string. */
  readonly amount: string;
  /** Optional base64 BOC for the message body. */
  readonly payload?: string;
  /** Optional base64 BOC for the contract's `StateInit` (deployments). */
  readonly stateInit?: string;
}

/** TON network global ID. Mainnet = -239, testnet = -3. */
export const networkGlobalIds = { mainnet: -239, testnet: -3 } as const;
export type NetworkGlobalId = (typeof networkGlobalIds)[keyof typeof networkGlobalIds];

export interface BuildExternalMessageInput {
  /** Detected wallet contract version. `unknown` is rejected before reaching here. */
  readonly walletVersion: Exclude<WalletVersion, "unknown">;
  /** Sender wallet address (the wallet that will sign and send). */
  readonly senderAddress: Address;
  /** The wallet's on-chain public key, as a 32-byte buffer. */
  readonly publicKey: Buffer;
  /** Current `seqno` reported by the wallet. */
  readonly seqno: number;
  /** Mainnet or testnet. Only consulted for V5R1's `walletId.networkGlobalId`. */
  readonly networkGlobalId: NetworkGlobalId;
  /** TON Connect messages to include as internal messages of the transfer. */
  readonly messages: readonly TonConnectMessage[];
  /**
   * Override the dummy private key for deterministic tests. Production callers
   * should leave this unset — every emulation gets a fresh random dummy key.
   *
   * The dummy key makes the wallet contract's `check_signature` call fail. For
   * unsigned-transaction emulation we rely on TONAPI's `ignore_signature_check`
   * (trace/event endpoints) — see `client.ts` open question.
   */
  readonly dummySecretKeyOverride?: Buffer;
}

// SendMode 3 = PAY_GAS_SEPARATELY + IGNORE_ERRORS — the wallet pays its own
// gas and discards messages whose action phase fails rather than aborting
// the whole transfer. Standard for TON Connect emulation per the cookbook.
const TRANSFER_SEND_MODE = SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS;

/**
 * Builds the base64-encoded external message BOC that TONAPI emulation
 * endpoints expect.
 *
 * Pure / asynchronous: no network. Async only because the dummy keypair
 * generator is async. All on-chain state needed for construction
 * (publicKey, seqno) is supplied by the caller via `fetchSenderMetadata`
 * or its equivalent in tests.
 *
 * Process:
 *   1. Construct the matching wallet contract (`WalletContractV3R2 | V4 | V5R1`).
 *   2. Generate a fresh dummy keypair (or use the test override).
 *   3. Convert each TON Connect message to a relaxed `internal()` message,
 *      attaching a `StateInit` parsed from `stateInit` if the message deploys.
 *   4. Call `wallet.createTransfer({ seqno, secretKey, sendMode, messages })`.
 *   5. Wrap the signed transfer in `external({ to: sender, init: undefined,
 *      body: transfer })` and BOC-serialise.
 *
 * Returns the base64 string suitable for `{ boc: <result> }` request bodies.
 */
export const buildExternalMessageBoc = async (
  input: BuildExternalMessageInput,
): Promise<string> => {
  const dummySecretKey = input.dummySecretKeyOverride ?? (await freshDummySecretKey());
  const internalMessages = input.messages.map(toInternalMessage);
  const transfer = createTransferForVersion(input, internalMessages, dummySecretKey);

  const externalCell = beginCell()
    .store(
      storeMessage(
        external({
          to: input.senderAddress,
          init: undefined,
          body: transfer,
        }),
      ),
    )
    .endCell();

  return externalCell.toBoc().toString("base64");
};

const toInternalMessage = (message: TonConnectMessage): MessageRelaxed => {
  const init = parseStateInit(message.stateInit);
  const body = parseBody(message.payload);

  return internal({
    to: Address.parse(message.address),
    value: BigInt(message.amount),
    bounce: true,
    body,
    init,
  });
};

const parseStateInit = (raw: string | undefined): StateInit | undefined => {
  if (raw === undefined) {
    return undefined;
  }

  return loadStateInit(Cell.fromBase64(raw).beginParse());
};

const parseBody = (raw: string | undefined): Cell | undefined =>
  raw === undefined ? undefined : Cell.fromBase64(raw);

/**
 * Dispatches `createTransfer` per wallet version. Each branch keeps the
 * concrete wallet contract type so TypeScript can resolve the (mutually
 * incompatible) `createTransfer` overloads V3R2/V4 share vs. V5R1's own.
 */
const createTransferForVersion = (
  input: Pick<
    BuildExternalMessageInput,
    "walletVersion" | "senderAddress" | "publicKey" | "seqno" | "networkGlobalId"
  >,
  messages: readonly MessageRelaxed[],
  secretKey: Buffer,
): Cell => {
  const workchain = input.senderAddress.workChain;
  const sendMode = TRANSFER_SEND_MODE;
  const seqno = input.seqno;
  const writableMessages = [...messages];

  switch (input.walletVersion) {
    case "v3r2": {
      const wallet = WalletContractV3R2.create({ workchain, publicKey: input.publicKey });
      return wallet.createTransfer({
        seqno,
        secretKey,
        sendMode,
        messages: writableMessages,
      });
    }

    case "v4r2": {
      const wallet = WalletContractV4.create({ workchain, publicKey: input.publicKey });
      return wallet.createTransfer({
        seqno,
        secretKey,
        sendMode,
        messages: writableMessages,
      });
    }

    case "v5r1": {
      const wallet = WalletContractV5R1.create({
        workchain,
        publicKey: input.publicKey,
        walletId: { networkGlobalId: input.networkGlobalId },
      });
      return wallet.createTransfer({
        seqno,
        secretKey,
        sendMode,
        messages: writableMessages,
        authType: "external",
      });
    }

    default:
      return assertNever(input.walletVersion);
  }
};

const freshDummySecretKey = async (): Promise<Buffer> => {
  const mnemonic = await mnemonicNew();
  const keypair = await mnemonicToPrivateKey(mnemonic);

  return keypair.secretKey;
};
