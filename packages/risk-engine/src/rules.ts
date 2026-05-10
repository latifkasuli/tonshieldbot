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

  // ── M2 emulation rules (spec §9.3) ────────────────────────────────────────
  // Live execution preview against TONAPI. Categorised under `emulation` to
  // distinguish from M1.5 static-decode findings under `transaction`. See
  // packages/ton-emulator and packages/ton-scanner/src/transaction/emulation*.

  {
    id: "EMULATION_SENDS_NEAR_FULL_BALANCE",
    category: "emulation",
    severity: "critical",
    title: "Transaction may sweep the wallet's TON balance",
    description:
      "TONAPI emulation determined the message can transfer all current and future remaining TON balance — the canonical drainer pattern.",
    recommendation: "Do not sign unless you intentionally want to empty this wallet.",
    defaultScoreDelta: 80,
  },
  {
    id: "EMULATION_WALLET_V5_AUTH_CHANGE",
    category: "emulation",
    severity: "critical",
    title: "Transaction modifies Wallet V5 authentication",
    description:
      "Emulation revealed an AddExtension, RemoveExtension, or SetSignatureAllowed action. These change who can authorise future transactions from this wallet.",
    recommendation:
      "Do not sign unless you are intentionally adding or removing a wallet extension that you trust.",
    defaultScoreDelta: 80,
  },
  {
    id: "EMULATION_DEPLOYS_UNKNOWN_CONTRACT",
    category: "emulation",
    severity: "high",
    title: "Transaction deploys an unrecognised contract",
    description:
      "Emulation revealed a ContractDeploy action that was not predicted by the static decode. The deployed code is unknown to TON Shield.",
    recommendation: "Only sign if you fully trust the app and understand the deployment.",
    defaultScoreDelta: 45,
  },
  {
    id: "EMULATION_SCAM_PATTERN_DETECTED",
    category: "emulation",
    severity: "high",
    title: "TONAPI flagged this interaction as scam-shaped",
    description:
      "TONAPI's account-event analyser marked the resulting event as `is_scam`. This is a heuristic, not a guarantee, but it correlates with known drainer patterns.",
    recommendation: "Do not sign without verifying the app through an official source.",
    defaultScoreDelta: 45,
  },
  {
    id: "EMULATION_ABORTED",
    category: "emulation",
    severity: "medium",
    title: "Emulated transaction aborted",
    description:
      "The emulated transaction's compute phase aborted. The actual transaction is likely to fail on-chain.",
    recommendation: "Do not sign. The transaction will probably fail and you will lose the gas.",
    defaultScoreDelta: 25,
  },
  {
    id: "EMULATION_REVEALED_HIDDEN_ACTION",
    category: "emulation",
    severity: "medium",
    title: "Emulation revealed actions the static decode did not predict",
    description:
      "The emulated trace contains downstream actions (e.g. Jetton notifications, NFT royalties, multisig fan-out) that the static message decoder did not show.",
    recommendation:
      "Review the full action list before signing — the transaction does more than the message body alone implies.",
    defaultScoreDelta: 25,
  },
  {
    id: "EMULATION_MISMATCH",
    category: "emulation",
    severity: "high",
    title: "Static preview disagrees with emulated outcome",
    description:
      "The destination, asset, or amount in the static decode does not match what the emulator reports will actually happen on-chain.",
    recommendation:
      "Treat as suspicious. Either the message is constructed misleadingly or one of the analyses is wrong.",
    defaultScoreDelta: 45,
  },
  {
    id: "EMULATION_FAILED",
    category: "emulation",
    severity: "low",
    title: "Emulation request failed",
    description:
      "TONAPI rejected the emulation request (4xx). The static decode is still authoritative for this report.",
    recommendation: "Treat the static-only report with extra caution.",
    defaultScoreDelta: 10,
  },
  {
    id: "EMULATION_RATE_LIMITED",
    category: "emulation",
    severity: "info",
    title: "Emulation rate-limited",
    description:
      "TONAPI returned 429. Emulation was not performed for this request, but the static decode is still authoritative.",
    recommendation: "Retry in a few seconds. If this persists, lower scan volume or upgrade the TONAPI tier.",
    defaultScoreDelta: 5,
  },
  {
    id: "EMULATION_PROVIDER_DOWN",
    category: "emulation",
    severity: "low",
    title: "Emulation provider unreachable",
    description:
      "TONAPI returned a 5xx or timed out. Emulation could not be performed; the static decode is the only signal in this report.",
    recommendation: "Treat the static-only report with extra caution and retry shortly.",
    defaultScoreDelta: 10,
  },
  {
    id: "EMULATION_SKIPPED_NO_SENDER",
    category: "emulation",
    severity: "info",
    title: "Emulation skipped — no sender address in transaction",
    description:
      "The transaction JSON did not include a `from` field. Without a sender, emulation cannot be performed and only the static decode is shown.",
    recommendation:
      "If you need a live execution preview, scan the transaction with the sender's wallet address attached.",
    defaultScoreDelta: 5,
  },
  {
    id: "EMULATION_SKIPPED_NO_MESSAGES",
    category: "emulation",
    severity: "info",
    title: "Emulation skipped — no `messages` array in transaction",
    description:
      "The transaction JSON has no `messages` array. The M1.5 static decoder accepts a permissive single-message format (top-level `to`/`value` or `address`/`amount`), but emulation requires the canonical TON Connect `messages[]` shape to build a wallet transfer. Static decode still ran.",
    recommendation:
      "For a live execution preview, paste a transaction in TON Connect format with a `messages` array.",
    defaultScoreDelta: 5,
  },
  {
    id: "EMULATION_NOT_CONFIGURED",
    category: "emulation",
    severity: "info",
    title: "Emulation disabled in this deployment",
    description:
      "TONAPI key is not configured in this environment. Reports show static-only decoding (M1.5).",
    recommendation:
      "If you operate this instance, set `TONAPI_KEY` to enable live execution preview.",
    defaultScoreDelta: 5,
  },
  {
    id: "EMULATION_SENDER_UNINITIALISED",
    category: "emulation",
    severity: "info",
    title: "Sender wallet has no on-chain state",
    description:
      "The sender address has not been deployed yet (no seqno, no public key on-chain). Emulation cannot be performed against an uninitialised account.",
    recommendation:
      "Deploy the wallet first, or scan with a sender that already has on-chain state.",
    defaultScoreDelta: 5,
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
