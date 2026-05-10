import {
  Address,
  beginCell,
  Cell,
  type ExtraCurrency,
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
  /**
   * Destination address in user-friendly format (`EQ...` or `UQ...`).
   *
   * The TON Connect spec requires user-friendly format because the wallet
   * derives the message's bounce flag from the address encoding (`EQ` =
   * bounceable, `UQ` = non-bounceable). Raw `0:...` addresses lack this and
   * are rejected — passing one would silently force a hardcoded default that
   * diverges from what a real wallet would send.
   */
  readonly address: string;
  /** Nanoton amount as an unsigned integer string. */
  readonly amount: string;
  /** Optional base64 BOC for the message body. */
  readonly payload?: string;
  /** Optional base64 BOC for the contract's `StateInit` (deployments). */
  readonly stateInit?: string;
  /**
   * Optional extra currencies sent alongside `amount`. Map of extra-currency
   * ID (uint32, encoded as a numeric string for JSON-friendliness) to the
   * amount in that currency's smallest unit (encoded as a string).
   *
   * TON dApps use this to transfer non-TON, non-Jetton native assets via the
   * TON Extra Currency mechanism. Omitting it from emulation requests would
   * make the emulated outcome understate outgoing assets vs. what the wallet
   * would actually send.
   */
  readonly extraCurrency?: Readonly<Record<string, string>>;
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
  const { address, bounce } = parseDestination(message.address);
  const value = parseAmountString(message.amount, "amount");
  const extracurrency = parseExtraCurrency(message.extraCurrency);

  return internal({
    to: address,
    value,
    bounce,
    body,
    init,
    extracurrency,
  });
};

/**
 * Parses a TON Connect amount string into a `bigint`, rejecting anything that
 * is not an unsigned decimal integer.
 *
 * Why we don't just call `BigInt()`: the JS `BigInt` constructor is far more
 * permissive than the TON Connect amount format. Without this guard:
 *   - `""`            → `0n` (silently accepts empty string)
 *   - `"0x10"`        → `16n` (silently parses hex)
 *   - `"  1000  "`    → `1000n` (silently strips whitespace)
 *   - `"+5"`          → `5n` (silently accepts unary plus)
 * For our scanner those would each be a different real-world bug shape that
 * we want surfaced as a malformed-message error, not silently coerced. The
 * same regex is what M1.5's static decoder uses (see
 * `packages/ton-scanner/src/transaction/message-parser.ts:parseUnsignedIntString`)
 * — keeping it consistent across the two scanners means the static and
 * emulated paths reject the same set of inputs.
 *
 * @param fieldLabel Human-readable label for the field this value belongs to
 *   (e.g. `"amount"`, `"extraCurrency amount for id 100"`), used in the
 *   thrown error message so PR-C can surface it as evidence on the
 *   malformed-message finding.
 */
const parseAmountString = (raw: string, fieldLabel: string): bigint => {
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${fieldLabel} must be an unsigned decimal integer string ` +
        `(no hex, whitespace, sign, or empty); received "${raw}"`,
    );
  }

  return BigInt(raw);
};

/**
 * Parses a TON Connect destination address and extracts its bounce flag.
 *
 * TON Connect requires user-friendly format (`EQ...` bounceable, `UQ...`
 * non-bounceable) because the wallet derives the message's bounce flag from
 * the address encoding. Raw `0:...` addresses carry no bounce information,
 * so accepting them would mean picking a hardcoded default — at which point
 * our emulation would produce a different on-chain outcome than the real
 * wallet for any UQ-shaped destination. We reject raw form rather than
 * silently misrepresent the message.
 */
const parseDestination = (raw: string): { address: Address; bounce: boolean } => {
  try {
    const parsed = Address.parseFriendly(raw);

    return { address: parsed.address, bounce: parsed.isBounceable };
  } catch {
    throw new Error(
      `TON Connect message destination must be a user-friendly address ` +
        `(EQ.../UQ...) so the bounce flag can be derived from the encoding; ` +
        `received "${raw}"`,
    );
  }
};

/**
 * Converts the TON Connect `extraCurrency` map (string→string for JSON
 * portability) into the `ExtraCurrency` shape `internal()` accepts
 * (`{ [k: number]: bigint }`).
 *
 * Returns `undefined` when no extras are present so `internal()` can short-
 * circuit and not even allocate the dictionary cell. Invalid IDs (non-
 * integers, negative, > 2^32-1) and invalid amounts (non-digit strings,
 * negative) throw — PR-C maps the throw onto a malformed-message finding
 * rather than letting it crash the scan.
 */
const parseExtraCurrency = (
  extraCurrency: Readonly<Record<string, string>> | undefined,
): ExtraCurrency | undefined => {
  if (extraCurrency === undefined) {
    return undefined;
  }

  const entries = Object.entries(extraCurrency);

  if (entries.length === 0) {
    return undefined;
  }

  const result: Record<number, bigint> = {};

  for (const [rawId, rawAmount] of entries) {
    const id = parseUint32(rawId);
    // Reuse the same strict decimal parser as `amount` so both fields reject
    // identical malformed inputs (empty / hex / whitespace / signed).
    result[id] = parseAmountString(rawAmount, `extraCurrency amount for id ${String(id)}`);
  }

  return result;
};

const parseUint32 = (raw: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`extraCurrency id must be a non-negative integer string; got "${raw}"`);
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < 0 || value > 0xff_ff_ff_ff) {
    throw new Error(`extraCurrency id ${raw} is outside the uint32 range`);
  }

  return value;
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
