import { Address, Cell } from "@ton/core";
import type { DecodedPayload } from "./types.ts";

const OP_COMMENT = 0x00000000;
const OP_JETTON_TRANSFER = 0x0f8a7ea5;
const OP_NFT_TRANSFER = 0x5fcc3d14;

// Matches the canonical empty-cell BOC that @ton/core produces for an empty cell.
// Any BOC with no bits that starts with the standard BoC magic + length header is treated as empty.
const EMPTY_BOC_PREFIX = "te6cckEBAQEAAgAAAA";

const isEmptyBoc = (boc: string): boolean => boc.length === 0 || boc.startsWith(EMPTY_BOC_PREFIX);

const addressToString = (address: Address): string => address.toString({ bounceable: true });

const maybeAddressToString = (address: Address | null): string | null =>
  address !== null ? addressToString(address) : null;

export const decodePayload = (boc: string): DecodedPayload => {
  if (isEmptyBoc(boc)) {
    return { kind: "none" };
  }

  let cell: Cell;

  try {
    cell = Cell.fromBase64(boc);
  } catch {
    return { kind: "opaque", opCode: null };
  }

  try {
    const slice = cell.beginParse();

    if (slice.remainingBits < 32) {
      // A completely empty cell (0 bits) is a valid "no payload" marker.
      // A non-empty cell with fewer than 32 bits cannot encode a valid op code —
      // treat it as opaque so it does not silently look like a plain transfer.
      return slice.remainingBits === 0 ? { kind: "none" } : { kind: "opaque", opCode: null };
    }

    const opCode = slice.loadUint(32);

    if (opCode === OP_COMMENT) {
      const text = slice.remainingBits >= 8 ? slice.loadStringTail() : "";

      return { kind: "ton_comment", text };
    }

    if (opCode === OP_JETTON_TRANSFER) {
      const queryId = slice.loadUintBig(64);
      const amount = slice.loadCoins();
      const destination = addressToString(slice.loadAddress());
      // response_destination is MsgAddress (not Maybe), so addr_none is encoded as 00 bits
      const responseDestination = maybeAddressToString(slice.loadMaybeAddress());

      // skip custom_payload (Maybe ^Cell)
      if (slice.loadBit()) {
        slice.loadRef();
      }

      const forwardAmount = slice.loadCoins();

      return {
        kind: "jetton_transfer",
        queryId,
        amount,
        destination,
        responseDestination,
        forwardAmount,
      };
    }

    if (opCode === OP_NFT_TRANSFER) {
      const queryId = slice.loadUintBig(64);
      const newOwner = addressToString(slice.loadAddress());
      // response_destination is MsgAddress (not Maybe)
      const responseDestination = maybeAddressToString(slice.loadMaybeAddress());

      // skip custom_payload (Maybe ^Cell)
      if (slice.loadBit()) {
        slice.loadRef();
      }

      const forwardAmount = slice.loadCoins();

      return {
        kind: "nft_transfer",
        queryId,
        newOwner,
        responseDestination,
        forwardAmount,
      };
    }

    return { kind: "opaque", opCode };
  } catch {
    return { kind: "opaque", opCode: null };
  }
};
