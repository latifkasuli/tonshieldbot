import type { ActionPreview, AssetDelta, ScanReport } from "@tonshield/shared";

export const welcomeMessage = [
  "TON Shield scans TON Connect links, Telegram Mini App links, TON addresses, BOCs, and transaction JSON.",
  "",
  "Paste something suspicious and I will return a preliminary risk report.",
].join("\n");

export const formatScanReport = (report: ScanReport): string => {
  const parts = [
    `Risk: ${formatVerdict(report.verdict)} (${String(report.riskScore)}/100)`,
    "",
    report.summary,
  ];

  if (report.actions.length > 0) {
    parts.push("", "Actions:");

    for (const action of report.actions) {
      parts.push(`• ${action.title}`);
      parts.push(`  ${action.description}`);

      const deltaLines = formatAssetDeltas(action.assetDeltas);

      if (deltaLines.length > 0) {
        parts.push(...deltaLines);
      }
    }
  }

  if (report.findings.length > 0) {
    parts.push("", "Findings:");

    for (const finding of report.findings.slice(0, 3)) {
      parts.push(`[${finding.severity.toUpperCase()}] ${finding.title}`);
      parts.push(`  ${finding.recommendation}`);
    }
  }

  if (report.verdict === "high" || report.verdict === "critical") {
    parts.push("", formatDangerWarning(report));
  }

  parts.push("", `Input type: ${report.input.kind}`, `Confidence: ${report.confidence}`);

  return parts.join("\n");
};

const formatVerdict = (verdict: ScanReport["verdict"]): string =>
  verdict.charAt(0).toUpperCase() + verdict.slice(1);

const formatDangerWarning = (report: ScanReport): string => {
  const { kind } = report.input;

  if (kind === "transaction_json" || kind === "boc") {
    return "Do not sign this transaction.";
  }

  return "Do not connect your wallet to this request.";
};

const formatAssetDeltas = (deltas: readonly AssetDelta[]): readonly string[] => {
  if (deltas.length === 0) {
    return [];
  }

  return deltas.map((delta) => {
    const arrow = delta.direction === "outgoing" ? "↑" : delta.direction === "incoming" ? "↓" : "?";
    const amount = delta.amount ?? "";
    const symbol = delta.symbol ?? delta.assetType.toUpperCase();
    const asset = amount.length > 0 ? `${amount} ${symbol}` : symbol;

    return `  ${arrow} ${asset}`;
  });
};

export const formatActionSummary = (action: ActionPreview): string => {
  const lines = [
    `• ${action.title}`,
    `  ${action.description}`,
    ...formatAssetDeltas(action.assetDeltas),
  ];

  return lines.join("\n");
};
