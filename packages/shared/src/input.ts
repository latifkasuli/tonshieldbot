export const scanInputKinds = [
  "telegram_handle",
  "telegram_url",
  "tonconnect_link",
  "manifest_url",
  "generic_url",
  "ton_address",
  "boc",
  "transaction_json",
  "unknown",
] as const;

export type ScanInputKind = (typeof scanInputKinds)[number];

export interface BaseScanInput {
  readonly kind: ScanInputKind;
  readonly raw: string;
  readonly normalized: string;
}

export interface TelegramHandleInput extends BaseScanInput {
  readonly kind: "telegram_handle";
  readonly handle: `@${string}`;
}

export interface TelegramUrlInput extends BaseScanInput {
  readonly kind: "telegram_url";
  readonly url: URL;
  readonly handle: string | null;
}

export interface TonConnectLinkInput extends BaseScanInput {
  readonly kind: "tonconnect_link";
  readonly requestId: string | null;
  readonly manifestUrl: URL;
  readonly returnStrategy: string | null;
}

export interface ManifestUrlInput extends BaseScanInput {
  readonly kind: "manifest_url";
  readonly url: URL;
}

export interface GenericUrlInput extends BaseScanInput {
  readonly kind: "generic_url";
  readonly url: URL;
}

export interface TonAddressInput extends BaseScanInput {
  readonly kind: "ton_address";
  readonly address: string;
}

export interface BocInput extends BaseScanInput {
  readonly kind: "boc";
  readonly boc: string;
}

export interface TransactionJsonInput extends BaseScanInput {
  readonly kind: "transaction_json";
  readonly transaction: Readonly<Record<string, unknown>>;
}

export interface UnknownInput extends BaseScanInput {
  readonly kind: "unknown";
  readonly reason: string;
}

export type ScanInput =
  | TelegramHandleInput
  | TelegramUrlInput
  | TonConnectLinkInput
  | ManifestUrlInput
  | GenericUrlInput
  | TonAddressInput
  | BocInput
  | TransactionJsonInput
  | UnknownInput;
