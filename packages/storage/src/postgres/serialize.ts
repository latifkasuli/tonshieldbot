import { assertNever } from "@tonshield/shared";
import type { ScanInput } from "@tonshield/shared";

/**
 * Round-trip helpers for storing `ScanInput` in `jsonb`.
 *
 * `ScanInput` carries `URL` instances which JSON-serialize to strings via
 * the built-in `URL.toJSON()`. The reverse direction is what we own here:
 * given a stored object we trust to have been a valid ScanInput, rebuild
 * the URL fields in place.
 *
 * Anything malformed throws — corruption is preferable to silently
 * returning a partial ScanInput downstream consumers will mishandle.
 */

export const serializeInput = (input: ScanInput): unknown =>
  // JSON.parse(JSON.stringify(...)) loses URL identity in favor of strings.
  // jsonb storage requires plain objects; the round-trip is the cleanest way.
  JSON.parse(JSON.stringify(input));

export const deserializeInput = (raw: unknown): ScanInput => {
  if (!isRecord(raw)) {
    throw new Error("Stored ScanInput is not an object");
  }

  const kind = raw.kind;

  if (typeof kind !== "string") {
    throw new Error("Stored ScanInput has no kind discriminator");
  }

  const base = {
    raw: requireString(raw, "raw"),
    normalized: requireString(raw, "normalized"),
  };

  switch (kind as ScanInput["kind"]) {
    case "telegram_handle":
      return {
        ...base,
        kind: "telegram_handle",
        handle: requireHandle(raw, "handle"),
      };

    case "telegram_url":
      return {
        ...base,
        kind: "telegram_url",
        url: requireUrl(raw, "url"),
        handle: requireNullableString(raw, "handle"),
      };

    case "telegram_deeplink": {
      const action = requireString(raw, "action");
      const extrasRaw = raw.extras;
      const extras: Record<string, string> = {};
      if (extrasRaw !== undefined && extrasRaw !== null && isRecord(extrasRaw)) {
        for (const [key, value] of Object.entries(extrasRaw)) {
          if (typeof value === "string") extras[key] = value;
        }
      }
      // The discriminator on the saved record is verified by the outer
      // switch; we trust the stored shape here.
      return {
        ...base,
        kind: "telegram_deeplink",
        url: requireUrl(raw, "url"),
        action: action as
          | "start"
          | "startapp"
          | "startattach"
          | "startgroup"
          | "startchannel"
          | "startbusiness"
          | "addBusinessBot",
        target: requireNullableString(raw, "target"),
        appShortName: requireNullableString(raw, "appShortName"),
        payload: requireNullableString(raw, "payload"),
        extras,
      };
    }

    case "telegram_miniapp_url":
      return {
        ...base,
        kind: "telegram_miniapp_url",
        url: requireUrl(raw, "url"),
        hostBot: requireNullableString(raw, "hostBot"),
      };

    case "telegram_nft_link":
      return {
        ...base,
        kind: "telegram_nft_link",
        url: requireUrl(raw, "url"),
        slug: requireString(raw, "slug"),
      };

    case "tonconnect_link":
      return {
        ...base,
        kind: "tonconnect_link",
        manifestUrl: requireUrl(raw, "manifestUrl"),
        requestId: requireNullableString(raw, "requestId"),
        returnStrategy: requireNullableString(raw, "returnStrategy"),
      };

    case "manifest_url":
      return { ...base, kind: "manifest_url", url: requireUrl(raw, "url") };

    case "generic_url":
      return { ...base, kind: "generic_url", url: requireUrl(raw, "url") };

    case "ton_address":
      return { ...base, kind: "ton_address", address: requireString(raw, "address") };

    case "boc":
      return { ...base, kind: "boc", boc: requireString(raw, "boc") };

    case "transaction_json": {
      const transaction = raw.transaction;

      if (!isRecord(transaction)) {
        throw new Error("Stored transaction_json input has no transaction object");
      }

      return { ...base, kind: "transaction_json", transaction };
    }

    case "unknown":
      return { ...base, kind: "unknown", reason: requireString(raw, "reason") };

    default:
      return assertNever(kind as never);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];

  if (typeof value !== "string") {
    throw new Error(`Stored ScanInput field ${key} is not a string`);
  }

  return value;
};

const requireNullableString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`Stored ScanInput field ${key} is neither string nor null`);
  }

  return value;
};

const requireUrl = (record: Record<string, unknown>, key: string): URL => {
  const value = requireString(record, key);

  try {
    return new URL(value);
  } catch {
    throw new Error(`Stored ScanInput field ${key} is not a valid URL: ${value}`);
  }
};

const requireHandle = (record: Record<string, unknown>, key: string): `@${string}` => {
  const value = requireString(record, key);

  if (!value.startsWith("@")) {
    throw new Error(`Stored ScanInput field ${key} does not start with @`);
  }

  return value as `@${string}`;
};
