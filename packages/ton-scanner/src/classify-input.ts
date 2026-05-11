import type { ScanInput } from "@tonshield/shared";
import { parseTelegramUrl } from "@tonshield/telegram-intel";
import { parseTonConnectLink } from "./ton-connect.ts";
import { parseUrl } from "./utils.ts";

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
  // Telegram URLs go through the deep-link parser first so we can
  // distinguish action-bearing links (`start*`, `nft`, addBusinessBot) from
  // plain handle references. Plain references degrade to `telegram_url`
  // for back-compat with the M1 manifest scanner.
  const parsedTg = parseTelegramUrl(url);

  if (parsedTg.kind === "deeplink") {
    return {
      kind: "telegram_deeplink",
      raw: rawInput,
      normalized: url.toString(),
      url,
      action: parsedTg.action,
      target: parsedTg.target,
      appShortName: parsedTg.appShortName,
      payload: parsedTg.payload,
    };
  }

  if (parsedTg.kind === "nft") {
    return {
      kind: "telegram_nft_link",
      raw: rawInput,
      normalized: url.toString(),
      url,
      slug: parsedTg.slug,
    };
  }

  if (parsedTg.kind === "plain_handle") {
    return {
      kind: "telegram_url",
      raw: rawInput,
      normalized: url.toString(),
      url,
      handle: parsedTg.handle,
    };
  }

  // `not_deeplink` for Telegram hosts (e.g. malformed t.me URL) — still
  // surface as telegram_url with no handle so the existing M1 scanner
  // can degrade gracefully. Treat `not_telegram` as the trigger to fall
  // through to the manifest / generic URL classifier below.
  if (parsedTg.kind === "not_deeplink") {
    return {
      kind: "telegram_url",
      raw: rawInput,
      normalized: url.toString(),
      url,
      handle: null,
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
