import { randomUUID } from "node:crypto";
import {
  confidenceFromFindings,
  createFinding,
  createScanReport,
  getCoreRule,
  scoreFindings,
  verdictFromScore,
} from "@tonshield/risk-engine";
import type { ActionPreview, RiskFinding, ScanInput, ScanReport } from "@tonshield/shared";
import type { FetchCache } from "@tonshield/safe-fetch";
import type { TonEmulatorClient } from "@tonshield/ton-emulator";
import { classifyInput } from "./classify-input.ts";
import { scanTonConnectManifest } from "./manifest-scanner.ts";
import { scanTransactionJson } from "./transaction/scanner.ts";
import { scanTransactionWithEmulation } from "./transaction/emulation-scanner.ts";

export interface CreateBasicScanInput {
  readonly id?: string;
  readonly rawInput: string;
  readonly now?: Date;
  /**
   * Manifest-fetch HTTP cache. Used by the TON Connect manifest scanner to
   * avoid hitting the same dApp manifest URL twice in quick succession.
   * Intentionally narrow — do not repurpose this for other services.
   */
  readonly cache?: FetchCache;
  /**
   * Optional TONAPI emulator client. When provided AND `client.enabled`
   * (i.e. `TONAPI_KEY` was set), `transaction_json` inputs get a live
   * `/v2/wallet/emulate` pass on top of the M1.5 static decode. When absent
   * or disabled, scans still produce a valid M1.5 report and surface
   * `EMULATION_NOT_CONFIGURED` so the omission is visible to operators.
   */
  readonly emulator?: TonEmulatorClient;
}

interface GatherResult {
  readonly findings: readonly RiskFinding[];
  readonly actions: readonly ActionPreview[];
}

export const createBasicScan = async (input: CreateBasicScanInput): Promise<ScanReport> => {
  const id = input.id ?? randomUUID();
  const classifiedInput = classifyInput(input.rawInput);
  // `exactOptionalPropertyTypes` rejects passing `undefined` explicitly;
  // build the dep bag by spreading only the fields that are actually set.
  const deps: GatherDeps = {
    ...(input.cache === undefined ? {} : { cache: input.cache }),
    ...(input.emulator === undefined ? {} : { emulator: input.emulator }),
  };
  const { findings, actions } = await gatherScanResult(classifiedInput, deps);
  const riskScore = scoreFindings(findings);
  const verdict = classifiedInput.kind === "unknown" ? "unknown" : verdictFromScore(riskScore);

  const reportInput = {
    id,
    input: classifiedInput,
    verdict,
    riskScore,
    confidence: confidenceFromFindings(findings),
    summary: summarizeInput(classifiedInput, findings),
    findings,
    actions,
    ...(input.now === undefined ? {} : { now: input.now }),
  };

  return createScanReport(reportInput);
};

interface GatherDeps {
  readonly cache?: FetchCache;
  readonly emulator?: TonEmulatorClient;
}

const gatherScanResult = async (input: ScanInput, deps: GatherDeps): Promise<GatherResult> => {
  if (input.kind === "unknown") {
    return {
      findings: [
        createFinding({
          confidence: "medium",
          evidence: { reason: input.reason },
          rule: getCoreRule("INPUT_UNKNOWN"),
        }),
      ],
      actions: [],
    };
  }

  // A bare manifest URL is the same scan target as a TON Connect deeplink's
  // `manifestUrl` — both fetch and validate the same JSON document, so we
  // route both through `scanTonConnectManifest`. Without this branch, a user
  // pasting just the manifest URL gets a falsely-clean report.
  if (input.kind === "tonconnect_link" || input.kind === "manifest_url") {
    const manifestUrl = input.kind === "tonconnect_link" ? input.manifestUrl : input.url;
    const { findings } = await scanTonConnectManifest(manifestUrl, deps.cache);

    return { findings, actions: [] };
  }

  if (input.kind === "transaction_json") {
    // Run the M1.5 static decode first — it is the source of truth for what
    // the dApp's `messages[]` field claims will happen, never replaced by
    // emulation. Then layer emulation findings/actions on top per spec
    // §9.3.3. Static actions and emulated actions are kept side-by-side; the
    // bot/api UI is responsible for any de-duplication it wants to do.
    const staticResult = scanTransactionJson(input);
    const emulationResult = await scanTransactionWithEmulation(deps.emulator, input, {
      staticActionCount: staticResult.actions.length,
      staticHasStateInit: hasStateInit(input.transaction),
    });

    return {
      findings: [...staticResult.findings, ...emulationResult.findings],
      actions: [...staticResult.actions, ...emulationResult.actions],
    };
  }

  return { findings: [], actions: [] };
};

const summarizeInput = (input: ScanInput, findings: readonly RiskFinding[]): string => {
  if (input.kind === "unknown") {
    return "TON Shield could not classify this input yet.";
  }

  if (input.kind === "transaction_json") {
    if (findings.length === 0) {
      return "Transaction JSON scanned. No risk signals detected.";
    }
  }

  if (findings.length === 0) {
    return `Scanned as ${input.kind}. No risk signals detected.`;
  }

  const topFinding = findings.reduce((top, finding) =>
    finding.scoreDelta > top.scoreDelta ? finding : top,
  );

  return topFinding.title;
};

/**
 * Quick check for any `stateInit` field on the transaction's messages.
 * Used by the emulation scanner's `EMULATION_DEPLOYS_UNKNOWN_CONTRACT`
 * diff: if emulation reveals a `ContractDeploy` action but no message
 * carried a `stateInit`, the deployment is happening as a side effect.
 */
const hasStateInit = (transaction: Readonly<Record<string, unknown>>): boolean => {
  const { messages } = transaction;

  if (!Array.isArray(messages)) {
    return false;
  }

  return messages.some((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }

    const msg = entry as Readonly<Record<string, unknown>>;
    const stateInit = msg.stateInit ?? msg.state_init;

    return typeof stateInit === "string" && stateInit.length > 0;
  });
};
