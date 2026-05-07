import { Address } from "@ton/core";
import { decodePayload } from "./payload-decoder.ts";
import type { ParsedMessage } from "./types.ts";

export interface ParseMessagesResult {
  readonly parsed: readonly ParsedMessage[];
  readonly malformedCount: number;
}

// ── field extractors ──────────────────────────────────────────────────────────

const getString = (obj: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = obj[key];

  return typeof value === "string" ? value : null;
};

const getNumber = (obj: Readonly<Record<string, unknown>>, key: string): number | null => {
  const value = obj[key];

  return typeof value === "number" ? value : null;
};

const getBoolean = (obj: Readonly<Record<string, unknown>>, key: string): boolean | null => {
  const value = obj[key];

  return typeof value === "boolean" ? value : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRecordArray = (value: unknown): value is readonly Record<string, unknown>[] =>
  Array.isArray(value) && value.every(isRecord);

// ── safe parsers ──────────────────────────────────────────────────────────────

const parseAddress = (raw: string): string | null => {
  try {
    return Address.parse(raw).toString({ bounceable: true });
  } catch {
    return null;
  }
};

/**
 * Parses a non-negative integer from a string. Rejects negatives, decimals,
 * hex, and anything that is not a pure digit sequence to prevent amount spoofing.
 */
const parseUnsignedIntString = (raw: string): bigint | null => {
  if (!/^\d+$/.test(raw)) return null;

  try {
    return BigInt(raw);
  } catch {
    return null;
  }
};

/**
 * Resolves the transfer amount from a message object.
 *
 * Returns the bigint value on success, or `"malformed"` when the amount field
 * is absent, non-integer, negative, or outside the safe integer range.
 * TON Connect requires an explicit amount on every message.
 */
const resolveAmount = (msg: Readonly<Record<string, unknown>>): bigint | "malformed" => {
  const strAmount = getString(msg, "amount") ?? getString(msg, "value");

  if (strAmount !== null) {
    return parseUnsignedIntString(strAmount) ?? "malformed";
  }

  const numAmount = getNumber(msg, "amount") ?? getNumber(msg, "value");

  if (numAmount !== null) {
    // Reject non-integers, negatives, and values outside the safe integer range
    // to avoid floating-point precision loss on large nanoton values.
    if (!Number.isInteger(numAmount) || numAmount < 0 || numAmount > Number.MAX_SAFE_INTEGER) {
      return "malformed";
    }

    return BigInt(numAmount);
  }

  // Amount is required; treat a missing field as malformed.
  return "malformed";
};

// ── message parsing ───────────────────────────────────────────────────────────

const parseMessage = (msg: Readonly<Record<string, unknown>>): ParsedMessage | "malformed" => {
  // Support both TON Connect format (address/amount) and raw format (to/value)
  const rawTo = getString(msg, "address") ?? getString(msg, "to") ?? getString(msg, "dest");
  const to = rawTo !== null ? parseAddress(rawTo) : null;

  if (to === null) {
    return "malformed";
  }

  const value = resolveAmount(msg);

  if (value === "malformed") {
    return "malformed";
  }
  const bounce = getBoolean(msg, "bounce") ?? true;
  const payloadBoc =
    getString(msg, "payload") ?? getString(msg, "body") ?? getString(msg, "stateBody") ?? "";
  const stateInitBoc = getString(msg, "stateInit") ?? getString(msg, "init") ?? null;
  const payload = decodePayload(payloadBoc);
  const hasStateInit = stateInitBoc !== null && stateInitBoc.length > 0;

  return { to, value, bounce, payload, hasStateInit };
};

export const parseMessages = (
  transaction: Readonly<Record<string, unknown>>,
): ParseMessagesResult => {
  const rawMessages =
    transaction.messages ?? transaction.msgs ?? transaction.outMessages ?? transaction.out_msgs;

  if (!isRecordArray(rawMessages)) {
    // Single-message format: the transaction object itself is the message
    const result = parseMessage(transaction);

    return result === "malformed"
      ? { parsed: [], malformedCount: 1 }
      : { parsed: [result], malformedCount: 0 };
  }

  // An explicitly empty messages array is not a valid TON Connect transaction
  if (rawMessages.length === 0) {
    return { parsed: [], malformedCount: 1 };
  }

  let malformedCount = 0;
  const parsed: ParsedMessage[] = [];

  for (const msg of rawMessages) {
    const result = parseMessage(msg);

    if (result === "malformed") {
      malformedCount += 1;
    } else {
      parsed.push(result);
    }
  }

  return { parsed, malformedCount };
};
