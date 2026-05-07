import type { ScanInput } from "@tonshield/shared";
import { parseTonConnectLink } from "./ton-connect.ts";

const telegramHandlePattern = /^@[A-Za-z0-9_]{5,32}$/;
const rawTonAddressPattern = /^-?\d+:[a-fA-F0-9]{64}$/;
const friendlyTonAddressPattern = /^(?:EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/;
const likelyBocPattern = /^te6[A-Za-z0-9+/=_-]{20,}$/;

export const classifyInput = (rawInput: string): ScanInput => {
  const trimmed = rawInput.trim();

  if (trimmed.length === 0) {
    return {
      kind: "unknown",
      raw: rawInput,
      normalized: "",
      reason: "empty_input",
    };
  }

  const transaction = parseTransactionJson(trimmed);

  if (transaction !== null) {
    return {
      kind: "transaction_json",
      raw: rawInput,
      normalized: trimmed,
      transaction,
    };
  }

  const tonConnect = parseTonConnectLink(trimmed);

  if (tonConnect.ok) {
    return {
      kind: "tonconnect_link",
      raw: rawInput,
      normalized: trimmed,
      requestId: tonConnect.value.requestId,
      manifestUrl: tonConnect.value.request.manifestUrl,
      returnStrategy: tonConnect.value.returnStrategy,
    };
  }

  if (telegramHandlePattern.test(trimmed)) {
    return {
      kind: "telegram_handle",
      raw: rawInput,
      normalized: trimmed.toLowerCase(),
      handle: `@${trimmed.slice(1)}`,
    };
  }

  const url = parseUrl(trimmed);

  if (url !== null) {
    return classifyUrl(rawInput, url);
  }

  if (rawTonAddressPattern.test(trimmed) || friendlyTonAddressPattern.test(trimmed)) {
    return {
      kind: "ton_address",
      raw: rawInput,
      normalized: trimmed,
      address: trimmed,
    };
  }

  if (likelyBocPattern.test(trimmed)) {
    return {
      kind: "boc",
      raw: rawInput,
      normalized: trimmed,
      boc: trimmed,
    };
  }

  return {
    kind: "unknown",
    raw: rawInput,
    normalized: trimmed,
    reason: "unsupported_input_shape",
  };
};

const classifyUrl = (rawInput: string, url: URL): ScanInput => {
  if (url.hostname === "t.me" || url.hostname === "telegram.me") {
    const handle = url.pathname.split("/").find((segment) => segment.length > 0) ?? null;

    return {
      kind: "telegram_url",
      raw: rawInput,
      normalized: url.toString(),
      url,
      handle,
    };
  }

  if (url.pathname.endsWith("/tonconnect-manifest.json")) {
    return {
      kind: "manifest_url",
      raw: rawInput,
      normalized: url.toString(),
      url,
    };
  }

  return {
    kind: "generic_url",
    raw: rawInput,
    normalized: url.toString(),
    url,
  };
};

const parseUrl = (rawInput: string): URL | null => {
  try {
    return new URL(rawInput);
  } catch {
    return null;
  }
};

const parseTransactionJson = (rawInput: string): Readonly<Record<string, unknown>> | null => {
  if (!rawInput.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawInput) as unknown;

    if (!isRecord(parsed)) {
      return null;
    }

    return Array.isArray(parsed.messages) ? parsed : null;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
