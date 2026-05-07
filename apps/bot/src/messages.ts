import type { ScanReport } from "@tonshield/shared";

export const welcomeMessage = [
  "TON Shield scans TON Connect links, Telegram Mini App links, TON addresses, BOCs, and transaction JSON.",
  "",
  "Paste something suspicious and I will return a preliminary risk report.",
].join("\n");

export const formatScanReport = (report: ScanReport): string =>
  [
    `Risk: ${formatVerdict(report.verdict)} (${String(report.riskScore)}/100)`,
    "",
    report.summary,
    "",
    `Input type: ${report.input.kind}`,
    `Confidence: ${report.confidence}`,
  ].join("\n");

const formatVerdict = (verdict: ScanReport["verdict"]): string =>
  verdict.charAt(0).toUpperCase() + verdict.slice(1);
