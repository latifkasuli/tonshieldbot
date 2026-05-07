import { createFinding, getCoreRule } from "@tonshield/risk-engine";
import type { ActionPreview, RiskFinding, TransactionJsonInput } from "@tonshield/shared";
import { classifyMessage } from "./action-classifier.ts";
import { parseMessages } from "./message-parser.ts";

export interface TransactionScanResult {
  readonly findings: readonly RiskFinding[];
  readonly actions: readonly ActionPreview[];
}

export const scanTransactionJson = (input: TransactionJsonInput): TransactionScanResult => {
  const { parsed, malformedCount } = parseMessages(input.transaction);
  const actions = parsed.map(classifyMessage);
  const findings: RiskFinding[] = [];

  if (malformedCount > 0) {
    findings.push(
      createFinding({
        confidence: "medium",
        evidence: { malformedCount },
        rule: getCoreRule("TRANSACTION_MALFORMED_MESSAGE"),
      }),
    );
  }

  for (const msg of parsed) {
    if (msg.payload.kind === "opaque") {
      findings.push(
        createFinding({
          confidence: "medium",
          evidence: {
            opCode:
              msg.payload.opCode !== null
                ? `0x${msg.payload.opCode.toString(16).padStart(8, "0")}`
                : null,
            to: msg.to,
          },
          rule: getCoreRule("TRANSACTION_OPAQUE_PAYLOAD"),
        }),
      );
    }
  }

  return { findings, actions };
};
