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
import type { TelegramEntityStore } from "@tonshield/storage";
import type { TelegramIntelClient } from "@tonshield/telegram-intel";
import type { TonEmulatorClient } from "@tonshield/ton-emulator";
import { scanBocWithEmulation } from "./boc/scanner.ts";
import { classifyInput } from "./classify-input.ts";
import { scanTonConnectManifest } from "./manifest-scanner.ts";
import { scanTelegramEntity } from "./telegram/scanner.ts";
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
  /**
   * Optional Telegram Bot API intel client. When provided AND
   * `client.enabled` (i.e. `TELEGRAM_INTEL_BOT_TOKEN` was set), Telegram-
   * shaped inputs get live Bot API enrichment. When absent or disabled,
   * scans surface `TELEGRAM_BOT_API_NOT_CONFIGURED`.
   */
  readonly telegramIntel?: TelegramIntelClient;
  /**
   * Telegram entity snapshot store. Required for any Telegram-shaped
   * scan. In production this comes from `storage.telegramEntities`;
   * tests can pass an in-memory store directly.
   */
  readonly telegramEntities?: TelegramEntityStore;
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
    ...(input.telegramIntel === undefined ? {} : { telegramIntel: input.telegramIntel }),
    ...(input.telegramEntities === undefined ? {} : { telegramEntities: input.telegramEntities }),
    ...(input.now === undefined ? {} : { now: input.now }),
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
  readonly telegramIntel?: TelegramIntelClient;
  readonly telegramEntities?: TelegramEntityStore;
  readonly now?: Date;
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

    // The static decoder and the emulation scanner both validate
    // `transaction.messages` structurally and both emit
    // `TRANSACTION_MALFORMED_MESSAGE` when it's broken. If the static side
    // already found malformed messages, we skip emulation — running it
    // would double-emit the rule (and double the score) for what is one
    // underlying defect. The static finding alone is sufficient and
    // definitive; nothing emulation can do is more useful.
    const staticFoundMalformed = staticResult.findings.some(
      (finding) => finding.ruleId === "TRANSACTION_MALFORMED_MESSAGE",
    );

    if (staticFoundMalformed) {
      return staticResult;
    }

    const emulationResult = await scanTransactionWithEmulation(deps.emulator, input, {
      staticMessages: staticResult.parsedMessages,
      staticHasStateInit: hasStateInit(input.transaction),
    });

    return {
      findings: [...staticResult.findings, ...emulationResult.findings],
      actions: [...staticResult.actions, ...emulationResult.actions],
    };
  }

  if (input.kind === "boc") {
    // Raw BOC inputs have no M1.5 static decode counterpart (M1.5 operates
    // on TON Connect transaction JSON, not raw cells). Emulation via
    // `/v2/events/emulate` is the only signal source here. When the
    // emulator is disabled, `scanBocWithEmulation` itself surfaces
    // `EMULATION_NOT_CONFIGURED` so the absence stays visible.
    const bocResult = await scanBocWithEmulation(deps.emulator, input);

    return { findings: bocResult.findings, actions: bocResult.actions };
  }

  // M3 PR-2: Telegram-shaped inputs. The scanner needs a snapshot store;
  // when it's absent (callers haven't wired it yet), we return an empty
  // result — same fail-soft posture as the rest of the gather pipeline.
  if (
    input.kind === "telegram_handle" ||
    input.kind === "telegram_url" ||
    input.kind === "telegram_deeplink"
  ) {
    if (deps.telegramEntities === undefined) {
      return { findings: [], actions: [] };
    }

    const scanInput = telegramScanInputFor(input);
    if (scanInput === null) {
      return { findings: [], actions: [] };
    }

    const result = await scanTelegramEntity(deps.telegramIntel, deps.telegramEntities, scanInput, {
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    return { findings: result.findings, actions: result.actions };
  }

  return { findings: [], actions: [] };
};

/**
 * Maps a classified Telegram-shaped input to the field set the scanner
 * expects. Returns `null` when the input lacks a resolvable target (e.g.
 * a malformed deep link with no `target`).
 */
const telegramScanInputFor = (
  input: ScanInput,
): { readonly userOrBotHandle?: string; readonly channelOrSupergroupHandle?: string } | null => {
  if (input.kind === "telegram_handle") {
    // Bare `@handle` — Bot API cannot resolve user/bot handles cold, so
    // we send this through `resolveUserOrBot` which always returns
    // `cannot_resolve_cold`. The scanner emits
    // `TELEGRAM_ENTITY_NOT_RESOLVABLE` with the right reason.
    return { userOrBotHandle: input.handle };
  }

  if (input.kind === "telegram_url") {
    if (input.handle === null) {
      return null;
    }
    // Bare `t.me/<handle>` — same constraint as `@handle`: we don't know
    // statically whether the target is a channel or a user/bot. Try the
    // channel path first; if Bot API returns 'chat not found' we'll
    // emit the not-resolvable finding with the correct reason mapping.
    return { channelOrSupergroupHandle: input.handle };
  }

  if (input.kind === "telegram_deeplink" && input.target !== null) {
    // Deep links target bots in nearly every case (`start*` requires a
    // bot; `addBusinessBot` targets a bot). Channel deep links (`?start=`
    // is not channel-valid) are rare. We route through the cold user/bot
    // path so the scanner emits `TELEGRAM_ENTITY_NOT_RESOLVABLE` with the
    // right reason for the common case.
    return { userOrBotHandle: input.target };
  }

  return null;
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

  if (input.kind === "boc") {
    if (findings.length === 0) {
      return "Raw BOC scanned. No risk signals detected.";
    }
  }

  if (
    input.kind === "telegram_handle" ||
    input.kind === "telegram_url" ||
    input.kind === "telegram_deeplink" ||
    input.kind === "telegram_miniapp_url" ||
    input.kind === "telegram_nft_link"
  ) {
    if (findings.length === 0) {
      return `Telegram ${input.kind === "telegram_handle" ? "handle" : input.kind.replace(/^telegram_/, "")} scanned. No risk signals detected.`;
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
