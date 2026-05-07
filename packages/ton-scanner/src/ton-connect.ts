import { z } from "zod";
import type { Result } from "@tonshield/shared";
import { err, ok } from "@tonshield/shared";

const connectItemSchema = z.looseObject({
  name: z.string().min(1),
  payload: z.string().optional(),
});

const connectRequestSchema = z.object({
  manifestUrl: z.url(),
  items: z.array(connectItemSchema).default([]),
});

export interface TonConnectRequest {
  readonly manifestUrl: URL;
  readonly items: readonly TonConnectRequestItem[];
}

export interface TonConnectRequestItem {
  readonly name: string;
  readonly payload?: string;
}

export interface ParsedTonConnectLink {
  readonly version: string | null;
  readonly requestId: string | null;
  readonly returnStrategy: string | null;
  readonly request: TonConnectRequest;
}

export type TonConnectParseError =
  | "invalid_url"
  | "missing_request"
  | "invalid_request_json"
  | "invalid_manifest_url";

export const parseTonConnectLink = (
  rawInput: string,
): Result<ParsedTonConnectLink, TonConnectParseError> => {
  const url = parseUrl(rawInput);

  if (url?.protocol !== "tc:") {
    return err("invalid_url");
  }

  const requestParam = url.searchParams.get("r");

  if (requestParam === null) {
    return err("missing_request");
  }

  const requestJson = parseJson(requestParam);

  if (!requestJson.ok) {
    return err("invalid_request_json");
  }

  const parsedRequest = connectRequestSchema.safeParse(requestJson.value);

  if (!parsedRequest.success) {
    return err("invalid_request_json");
  }

  const manifestUrl = parseUrl(parsedRequest.data.manifestUrl);

  if (manifestUrl === null) {
    return err("invalid_manifest_url");
  }

  const items = parsedRequest.data.items.map((item): TonConnectRequestItem => {
    if (item.payload === undefined) {
      return {
        name: item.name,
      };
    }

    return {
      name: item.name,
      payload: item.payload,
    };
  });

  return ok({
    version: url.searchParams.get("v"),
    requestId: url.searchParams.get("id"),
    returnStrategy: url.searchParams.get("ret"),
    request: {
      manifestUrl,
      items,
    },
  });
};

const parseUrl = (rawInput: string): URL | null => {
  try {
    return new URL(rawInput);
  } catch {
    return null;
  }
};

type JsonParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

const parseJson = (rawInput: string): JsonParseResult => {
  try {
    return { ok: true, value: JSON.parse(rawInput) as unknown };
  } catch {
    return { ok: false };
  }
};
