import type { ScanInput } from "./input.ts";
import type { ConfidenceLevel, RiskFinding, Verdict } from "./risk.ts";

export const actionKinds = [
  "connect_wallet",
  "send_ton",
  "send_jetton",
  "send_nft",
  "deploy_contract",
  "change_wallet_permission",
  "unknown",
] as const;

export type ActionKind = (typeof actionKinds)[number];

export interface ActionPreview {
  readonly kind: ActionKind;
  readonly title: string;
  readonly description: string;
  readonly assetDeltas: readonly AssetDelta[];
}

export interface AssetDelta {
  readonly assetType: "ton" | "jetton" | "nft" | "unknown";
  readonly direction: "incoming" | "outgoing" | "unknown";
  readonly amount: string | null;
  readonly symbol: string | null;
  readonly from: string | null;
  readonly to: string | null;
}

export interface ScanReport {
  readonly id: string;
  readonly createdAt: string;
  readonly input: ScanInput;
  readonly verdict: Verdict;
  readonly riskScore: number;
  readonly confidence: ConfidenceLevel;
  readonly summary: string;
  readonly findings: readonly RiskFinding[];
  readonly actions: readonly ActionPreview[];
}

export interface CreateReportInput {
  readonly id: string;
  readonly input: ScanInput;
  readonly verdict: Verdict;
  readonly riskScore: number;
  readonly confidence: ConfidenceLevel;
  readonly summary: string;
  readonly findings: readonly RiskFinding[];
  readonly actions?: readonly ActionPreview[];
  readonly now?: Date;
}
