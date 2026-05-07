export type DecodedPayload =
  | { readonly kind: "none" }
  | { readonly kind: "ton_comment"; readonly text: string }
  | {
      readonly kind: "jetton_transfer";
      readonly queryId: bigint;
      readonly amount: bigint;
      readonly destination: string;
      readonly responseDestination: string | null;
      readonly forwardAmount: bigint;
    }
  | {
      readonly kind: "nft_transfer";
      readonly queryId: bigint;
      readonly newOwner: string;
      readonly responseDestination: string | null;
      readonly forwardAmount: bigint;
    }
  | { readonly kind: "opaque"; readonly opCode: number | null };

export interface ParsedMessage {
  readonly to: string;
  readonly value: bigint;
  readonly bounce: boolean;
  readonly payload: DecodedPayload;
  readonly hasStateInit: boolean;
}
