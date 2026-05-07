import type { RuleDefinition } from "@tonshield/shared";

export const coreRules = [
  {
    id: "INPUT_UNKNOWN",
    category: "input",
    severity: "info",
    title: "Input type is not supported yet",
    description: "TON Shield could not confidently classify this input.",
    recommendation:
      "Paste a TON Connect link, Telegram link, TON address, transaction JSON, or BOC.",
    defaultScoreDelta: 10,
  },
  {
    id: "TONCONNECT_MANIFEST_ORIGIN_MISMATCH",
    category: "tonconnect",
    severity: "high",
    title: "TON Connect manifest origin mismatch",
    description: "The manifest is hosted on one origin but claims a different app URL.",
    recommendation:
      "Do not connect unless the app identity is verified through an official source.",
    defaultScoreDelta: 45,
  },
  {
    id: "TONCONNECT_MANIFEST_URL_INVALID",
    category: "tonconnect",
    severity: "medium",
    title: "Invalid TON Connect manifest URL",
    description:
      "The TON Connect request contains a manifest URL that is not a valid absolute URL.",
    recommendation: "Treat this request as suspicious and avoid connecting your wallet.",
    defaultScoreDelta: 30,
  },
  {
    id: "TRANSACTION_OPAQUE_PAYLOAD",
    category: "transaction",
    severity: "medium",
    title: "Transaction contains an opaque payload",
    description: "The transaction calls a contract with data TON Shield cannot decode yet.",
    recommendation: "Only sign this request if you fully trust the app and understand the action.",
    defaultScoreDelta: 25,
  },
  {
    id: "JETTON_UNKNOWN_ASSET",
    category: "jetton",
    severity: "medium",
    title: "Jetton is not in the trusted asset registry",
    description: "This Jetton is not currently linked to a trusted TON Shield project identity.",
    recommendation: "Verify the Jetton master address before trusting its name, ticker, or icon.",
    defaultScoreDelta: 25,
  },
] as const satisfies readonly RuleDefinition[];

export type CoreRuleId = (typeof coreRules)[number]["id"];

export const getCoreRule = (id: CoreRuleId): RuleDefinition => {
  const rule = coreRules.find((candidate) => candidate.id === id);

  if (rule === undefined) {
    throw new Error(`Unknown core rule: ${id}`);
  }

  return rule;
};
