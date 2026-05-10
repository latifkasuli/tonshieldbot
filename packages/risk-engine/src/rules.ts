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
    description:
      "The manifest is served from a different registrable domain than the declared app URL after a cross-origin redirect.",
    recommendation:
      "Do not connect unless the app identity is verified through an official source.",
    defaultScoreDelta: 45,
  },
  {
    id: "TONCONNECT_MANIFEST_EXTERNAL_HOST",
    category: "tonconnect",
    severity: "low",
    title: "Manifest hosted on a different registrable domain than the app",
    description:
      "The TON Connect SDK allows hosting the manifest on any host, including a CDN that does not match the declared app URL. This is not a protocol violation, but is worth noting.",
    recommendation:
      "Verify the app identity through an official source before connecting if you do not recognize the manifest host.",
    defaultScoreDelta: 10,
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
  {
    id: "TONCONNECT_MANIFEST_SSRF_BLOCKED",
    category: "tonconnect",
    severity: "high",
    title: "Manifest URL targets internal infrastructure",
    description:
      "The manifest URL resolved to a private, loopback, link-local, or reserved IP address.",
    recommendation: "Do not connect. This request may be probing internal systems.",
    defaultScoreDelta: 45,
  },
  {
    id: "TONCONNECT_MANIFEST_FETCH_FAILED",
    category: "tonconnect",
    severity: "medium",
    title: "Manifest could not be fetched",
    description:
      "TON Shield was unable to retrieve the TON Connect manifest or the response was too large.",
    recommendation:
      "Do not connect until the app identity can be verified through an official source.",
    defaultScoreDelta: 20,
  },
  {
    id: "TONCONNECT_MANIFEST_INVALID",
    category: "tonconnect",
    severity: "medium",
    title: "Manifest content is invalid",
    description:
      "The fetched manifest did not pass schema validation. Required fields are missing or malformed.",
    recommendation:
      "Treat this request with caution. A legitimate app should have a valid TON Connect manifest.",
    defaultScoreDelta: 20,
  },
  {
    id: "TONCONNECT_MANIFEST_CONTENT_SUSPICIOUS",
    category: "tonconnect",
    severity: "low",
    title: "Manifest served with unexpected content type",
    description: "The manifest URL returned HTML or an unrecognized content type instead of JSON.",
    recommendation: "Verify the manifest URL points to a valid JSON file before connecting.",
    defaultScoreDelta: 10,
  },
  {
    id: "TRANSACTION_MALFORMED_MESSAGE",
    category: "transaction",
    severity: "medium",
    title: "Transaction contains unreadable messages",
    description:
      "One or more messages in the transaction could not be decoded. The destination address or amount is missing or malformed.",
    recommendation:
      "Treat this transaction with caution. A legitimate app should produce well-formed messages.",
    defaultScoreDelta: 25,
  },
  {
    id: "TONCONNECT_PROJECT_IMPERSONATION",
    category: "tonconnect",
    severity: "critical",
    title: "Known project impersonation detected",
    description:
      "The manifest name, manifest host, or declared app URL resembles a known project but is not on its official domain.",
    recommendation:
      "Do not connect. Verify this request through the official project channels first.",
    defaultScoreDelta: 80,
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
