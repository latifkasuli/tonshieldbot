import { Address } from "@ton/core";
import { createFinding, getCoreRule } from "@tonshield/risk-engine";
import type { ActionPreview, RiskFinding, TransactionJsonInput } from "@tonshield/shared";
import {
  buildExternalMessageBoc,
  emulateMessageToWallet,
  fetchSenderMetadata,
  type EmulatedAction,
  type EmulatedActionKind,
  type EmulationResult,
  type SenderMetadata,
  type TonEmulatorClient,
  type TonConnectMessage,
} from "@tonshield/ton-emulator";

export interface EmulationScanResult {
  readonly findings: readonly RiskFinding[];
  readonly actions: readonly ActionPreview[];
}

const EMPTY_RESULT: EmulationScanResult = { findings: [], actions: [] };

/**
 * Scans a `transaction_json` input by running it through TONAPI's
 * `/v2/wallet/emulate` and converting the response to TON Shield findings
 * and action previews.
 *
 * Degradation paths surfaced as findings:
 *   - emulator absent or `enabled === false` → `EMULATION_NOT_CONFIGURED`
 *   - transaction has no `from` field → `EMULATION_SKIPPED_NO_SENDER`
 *   - sender exists but is uninitialised on-chain → `EMULATION_SENDER_UNINITIALISED`
 *   - request builder throws on a malformed message field →
 *     `TRANSACTION_MALFORMED_MESSAGE` (reusing the M1.5 rule, with the
 *     thrown error in evidence)
 *   - TONAPI 429 (rate-limited) → `EMULATION_RATE_LIMITED`
 *   - TONAPI 5xx, timeout, or network failure → `EMULATION_PROVIDER_DOWN`
 *   - TONAPI 4xx (other than 429) → `EMULATION_FAILED`
 *
 * All provider-failure findings are low/info severity so the static decode
 * remains the authoritative signal and users don't see scary risk scores
 * just because TONAPI hiccupped.
 *
 * Trace-emulate fallback for non-wallet senders is PR-D2/D3 scope; unknown
 * wallet contracts still degrade silently to static-only here.
 *
 * The static `scanTransactionJson` runs FIRST in `gatherScanResult`; this
 * scanner only adds to its results — we never replace the static decode.
 * A static action and an emulated action that agree on `(kind, destination)`
 * are deduped by the caller.
 */
export const scanTransactionWithEmulation = async (
  client: TonEmulatorClient | undefined,
  input: TransactionJsonInput,
  staticContext: {
    readonly staticActionCount: number;
    readonly staticHasStateInit: boolean;
  },
): Promise<EmulationScanResult> => {
  if (!client?.enabled) {
    return single(emulationFinding("EMULATION_NOT_CONFIGURED"));
  }

  const senderResult = extractSenderAddress(input.transaction);

  if (senderResult.status === "missing") {
    return single(emulationFinding("EMULATION_SKIPPED_NO_SENDER"));
  }

  if (senderResult.status === "invalid") {
    return single(
      emulationFinding("EMULATION_SKIPPED_NO_SENDER", {
        reason: "from_unparseable",
        from: senderResult.raw,
      }),
    );
  }

  const metadataResult = await fetchSenderMetadata(client, senderResult.address);

  if (metadataResult.status === "uninitialised") {
    return single(
      emulationFinding("EMULATION_SENDER_UNINITIALISED", {
        from: senderResult.address.toString(),
      }),
    );
  }

  if (metadataResult.status === "unknown_wallet") {
    // PR-D adds the trace-emulate fallback for non-wallet senders. PR-C
    // skips silently — surfacing every "we can't emulate this kind of
    // sender" as a finding would be noisy and the user has no remedy.
    return EMPTY_RESULT;
  }

  if (metadataResult.status === "fetch_failed") {
    return single(
      providerFailureFinding({
        source: "metadata_fetch",
        httpStatus: metadataResult.httpStatus,
      }),
    );
  }

  const messagesResult = parseTonConnectMessages(input.transaction);

  if (messagesResult.status === "no_messages_field") {
    // Single-message format input — static decoder accepts it, emulator
    // can't (we'd need to synthesise a TON Connect messages[] from the
    // top-level fields, which is PR-D scope at the earliest). Skip cleanly
    // so the static report stays consistent with M1.5 behaviour.
    return single(emulationFinding("EMULATION_SKIPPED_NO_MESSAGES"));
  }

  if (messagesResult.status === "malformed") {
    // The parser is strict: any structurally bad entry rejects the whole
    // request. Emulating only the well-formed subset would silently truncate
    // the user-intended action list and produce a misleading risk report —
    // TON Connect `messages` is semantically ordered.
    return single(
      createFinding({
        confidence: "high",
        evidence: {
          source: "emulation_scanner_parser",
          reason: messagesResult.reason,
          ...(messagesResult.index === null ? {} : { index: messagesResult.index }),
        },
        rule: getCoreRule("TRANSACTION_MALFORMED_MESSAGE"),
      }),
    );
  }

  let boc: string;

  try {
    boc = await buildExternalMessageBoc({
      walletVersion: metadataResult.metadata.walletVersion,
      senderAddress: senderResult.address,
      publicKey: metadataResult.metadata.publicKey,
      seqno: metadataResult.metadata.seqno,
      networkGlobalId: metadataResult.metadata.networkGlobalId,
      messages: messagesResult.messages,
    });
  } catch (error) {
    return single(
      createFinding({
        confidence: "high",
        evidence: {
          source: "emulation_request_builder",
          reason: error instanceof Error ? error.message : String(error),
        },
        rule: getCoreRule("TRANSACTION_MALFORMED_MESSAGE"),
      }),
    );
  }

  const result = await emulateMessageToWallet(client, boc);

  if (result.status === "skipped") {
    // The wrapper short-circuits when `client.enabled` is false; we already
    // checked above, so this branch is defensive.
    return single(emulationFinding("EMULATION_NOT_CONFIGURED"));
  }

  if (result.status === "failed") {
    return single(
      providerFailureFinding({
        source: "emulate_call",
        reason: result.reason,
        httpStatus: result.httpStatus,
      }),
    );
  }

  return mapOkResult(result, senderResult.address, staticContext, metadataResult.metadata);
};

// ── result mapping ──────────────────────────────────────────────────────────

const mapOkResult = (
  result: Extract<EmulationResult, { status: "ok" }>,
  senderAddress: Address,
  staticContext: {
    readonly staticActionCount: number;
    readonly staticHasStateInit: boolean;
  },
  metadata: SenderMetadata,
): EmulationScanResult => {
  const findings: RiskFinding[] = [];
  const actions = result.actions.map(toActionPreview);

  // Risk-derived findings (TONAPI's pre-computed Risk object).
  if (result.risk.transferAllRemainingBalance) {
    findings.push(
      createFinding({
        confidence: "high",
        evidence: {
          tonNano: result.risk.tonNano.toString(),
          jettonCount: result.risk.jettons.length,
          nftCount: result.risk.nfts.length,
        },
        rule: getCoreRule("EMULATION_SENDS_NEAR_FULL_BALANCE"),
      }),
    );
  }

  // Wallet V5 auth changes are critical regardless of which side surfaced
  // them. Emit one finding per occurrence so each can be inspected.
  for (const action of result.actions) {
    if (isWalletAuthChangeKind(action.kind)) {
      findings.push(
        createFinding({
          confidence: "high",
          evidence: {
            kind: action.kind,
            rawType: action.rawType,
            walletVersion: metadata.walletVersion,
            simplePreview: action.simplePreview,
          },
          rule: getCoreRule("EMULATION_WALLET_V5_AUTH_CHANGE"),
        }),
      );
    }
  }

  // Aborted root transaction means the actual on-chain submission would
  // likely fail too — gas burned for nothing. Medium severity.
  if (result.trace.aborted) {
    findings.push(
      createFinding({
        confidence: "high",
        evidence: { from: senderAddress.toString() },
        rule: getCoreRule("EMULATION_ABORTED"),
      }),
    );
  }

  if (result.trace.isScam) {
    findings.push(
      createFinding({
        confidence: "medium",
        evidence: { from: senderAddress.toString() },
        rule: getCoreRule("EMULATION_SCAM_PATTERN_DETECTED"),
      }),
    );
  }

  // Conservative diff signals (per PR-C scope). These are deliberately not
  // exhaustive — fancier matching (per-message destination/amount diff)
  // lives in PR-D's expansion if it proves useful in practice.

  // Hidden actions: emulated event has more actions than the static decoder
  // produced. Common when downstream Jetton notifications, NFT royalty
  // forwards, or multisig fan-out happen, but also surfaces messages the
  // wallet's signed body emits that the dApp didn't put in the public
  // `messages[]` (the most security-relevant case).
  if (result.actions.length > staticContext.staticActionCount) {
    findings.push(
      createFinding({
        confidence: "medium",
        evidence: {
          staticActionCount: staticContext.staticActionCount,
          emulatedActionCount: result.actions.length,
        },
        rule: getCoreRule("EMULATION_REVEALED_HIDDEN_ACTION"),
      }),
    );
  }

  // ContractDeploy in emulation but no `stateInit` field on any static
  // message → the deployment is happening as a side effect, not from the
  // visible transaction body. High-signal.
  const emulatedDeploy = result.actions.some((a) => a.kind === "contract_deploy");

  if (emulatedDeploy && !staticContext.staticHasStateInit) {
    findings.push(
      createFinding({
        confidence: "high",
        evidence: { reason: "deploy_only_in_emulation" },
        rule: getCoreRule("EMULATION_DEPLOYS_UNKNOWN_CONTRACT"),
      }),
    );
  }

  return { findings, actions };
};

// ── helpers ─────────────────────────────────────────────────────────────────

const isWalletAuthChangeKind = (kind: EmulatedActionKind): boolean =>
  kind === "add_extension" || kind === "remove_extension" || kind === "set_signature_allowed";

const toActionPreview = (action: EmulatedAction): ActionPreview => ({
  kind: mapEmulatedKindToActionKind(action.kind),
  title: actionTitleFor(action),
  // Prefer TONAPI's own simple_preview text — it is the format already shown
  // to users elsewhere in the TON ecosystem and aligns with what wallets
  // display. We only override when we know better (auth changes get an
  // explicit warning prefix).
  description: action.simplePreview,
  assetDeltas: [],
});

const actionTitleFor = (action: EmulatedAction): string => {
  switch (action.kind) {
    case "ton_transfer":
    case "extra_currency_transfer":
      return "Send TON (emulated)";
    case "jetton_transfer":
    case "flawed_jetton_transfer":
    case "jetton_burn":
    case "jetton_mint":
      return "Jetton operation (emulated)";
    case "jetton_swap":
      return "Jetton swap (emulated)";
    case "nft_transfer":
    case "nft_purchase":
    case "auction_bid":
      return "NFT operation (emulated)";
    case "contract_deploy":
      return "Deploy contract (emulated)";
    case "add_extension":
      return "⚠ Add wallet extension (emulated)";
    case "remove_extension":
      return "⚠ Remove wallet extension (emulated)";
    case "set_signature_allowed":
      return "⚠ Change signature auth (emulated)";
    case "smart_contract_exec":
    case "subscribe":
    case "unsubscribe":
    case "deposit_stake":
    case "withdraw_stake":
    case "withdraw_stake_request":
    case "elections_deposit_stake":
    case "elections_recover_stake":
    case "deposit_token_stake":
    case "withdraw_token_stake_request":
    case "liquidity_deposit":
    case "domain_renew":
    case "purchase":
    case "gas_relay":
    case "unknown":
      // Fall back to TONAPI's raw type label suffixed with "(emulated)" for
      // anything we don't render with a specialised title yet.
      return `${action.rawType} (emulated)`;
  }
};

/**
 * Maps our internal `EmulatedActionKind` enum onto the broader `ActionKind`
 * shape used in `ActionPreview`. Several emulated kinds collapse onto the
 * same external category — e.g. all jetton operations show as `send_jetton`,
 * all NFT operations as `send_nft` — to keep the consumer-facing
 * `ActionPreview.kind` enum compact.
 */
const mapEmulatedKindToActionKind = (kind: EmulatedActionKind): ActionPreview["kind"] => {
  switch (kind) {
    case "ton_transfer":
    case "extra_currency_transfer":
      return "send_ton";

    case "jetton_transfer":
    case "flawed_jetton_transfer":
    case "jetton_burn":
    case "jetton_mint":
    case "jetton_swap":
      return "send_jetton";

    case "nft_transfer":
    case "nft_purchase":
    case "auction_bid":
      return "send_nft";

    case "contract_deploy":
      return "deploy_contract";

    case "add_extension":
    case "remove_extension":
    case "set_signature_allowed":
      return "change_wallet_permission";

    case "smart_contract_exec":
    case "subscribe":
    case "unsubscribe":
    case "deposit_stake":
    case "withdraw_stake":
    case "withdraw_stake_request":
    case "elections_deposit_stake":
    case "elections_recover_stake":
    case "deposit_token_stake":
    case "withdraw_token_stake_request":
    case "liquidity_deposit":
    case "domain_renew":
    case "purchase":
    case "gas_relay":
    case "unknown":
      return "unknown";
  }
};

// ── input parsing ───────────────────────────────────────────────────────────

type SenderExtractionResult =
  | { readonly status: "ok"; readonly address: Address }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly raw: string };

const getString = (obj: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = obj[key];

  return typeof value === "string" ? value : null;
};

const extractSenderAddress = (
  transaction: Readonly<Record<string, unknown>>,
): SenderExtractionResult => {
  const raw = getString(transaction, "from");

  if (raw === null) {
    return { status: "missing" };
  }

  try {
    return { status: "ok", address: Address.parse(raw) };
  } catch {
    return { status: "invalid", raw };
  }
};

type TonConnectMessagesParseResult =
  | { readonly status: "ok"; readonly messages: readonly TonConnectMessage[] }
  | { readonly status: "malformed"; readonly reason: string; readonly index: number | null }
  /**
   * Transaction has no `messages` field at all. The M1.5 static decoder
   * accepts a permissive single-message format (top-level `to`/`value`
   * etc.) which is valid input by its standards — surfacing
   * `TRANSACTION_MALFORMED_MESSAGE` would falsely contradict the static
   * decode. We skip emulation gracefully via `EMULATION_SKIPPED_NO_MESSAGES`
   * instead. (PR-D scope: optionally support the single-message shape end-
   * to-end if it proves useful.)
   */
  | { readonly status: "no_messages_field" };

/**
 * Extracts the messages array from a TON Connect transaction object as a
 * `TonConnectMessage[]`. Strictly all-or-nothing: if any entry is structurally
 * malformed, the entire request is rejected.
 *
 * Why all-or-nothing: TON Connect `messages` is a semantically ordered batch
 * — emulating only the well-formed subset would silently truncate the
 * user's intended action list and produce a misleading risk report. A
 * dropped message is the most security-relevant kind of corruption (a real
 * wallet would refuse to sign), so we surface it as
 * `TRANSACTION_MALFORMED_MESSAGE` and skip emulation entirely.
 *
 * Validation:
 *   - `messages` MUST be a non-empty array (TON Connect requires ≥ 1
 *     message per transaction)
 *   - every entry MUST be an object/record
 *   - every entry MUST have string `address` and string `amount` fields
 *   - `payload` / `stateInit` / `extraCurrency` are optional but, if
 *     present, must be the right type (string / string / object)
 *
 * Field-value validation (e.g. amount must be a decimal-integer string,
 * address must be friendly form) is the request builder's job; this parser
 * only enforces structural shape.
 */
const parseTonConnectMessages = (
  transaction: Readonly<Record<string, unknown>>,
): TonConnectMessagesParseResult => {
  const raw = transaction.messages;

  // Distinguish "field absent" from "field present but wrong type":
  //   - absent → static decode might still produce a valid report via the
  //     single-message fallback (top-level address/amount); skip emulation
  //     gracefully to preserve M1.5 backwards compat.
  //   - present but not an array → malformed (the dApp has a real bug).
  if (raw === undefined) {
    return { status: "no_messages_field" };
  }

  if (!Array.isArray(raw)) {
    return {
      status: "malformed",
      reason: "messages field is not an array",
      index: null,
    };
  }

  if (raw.length === 0) {
    return {
      status: "malformed",
      reason: "messages array is empty (TON Connect requires at least one message)",
      index: null,
    };
  }

  const messages: TonConnectMessage[] = [];
  // After `Array.isArray(raw)`, TS narrows the contents to `any` (because
  // `raw` came from an index access on `Record<string, unknown>`). Re-cast
  // to `unknown[]` so the loop body is forced to narrow each entry.
  const entries = raw as readonly unknown[];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return {
        status: "malformed",
        reason: "message entry is not an object",
        index,
      };
    }

    const message = entry as Readonly<Record<string, unknown>>;
    const address = getString(message, "address");

    if (address === null) {
      return {
        status: "malformed",
        reason: "message is missing required string `address` field",
        index,
      };
    }

    const amount = getString(message, "amount");

    if (amount === null) {
      return {
        status: "malformed",
        reason: "message is missing required string `amount` field",
        index,
      };
    }

    const payload = getString(message, "payload");
    const stateInit = getString(message, "stateInit") ?? getString(message, "state_init");
    const extraRaw = message.extraCurrency ?? message.extra_currency;

    if (extraRaw !== undefined && !isStringRecord(extraRaw)) {
      return {
        status: "malformed",
        reason: "message `extraCurrency` field must be a string→string map",
        index,
      };
    }

    messages.push({
      address,
      amount,
      ...(payload === null ? {} : { payload }),
      ...(stateInit === null ? {} : { stateInit }),
      ...(extraRaw === undefined ? {} : { extraCurrency: extraRaw }),
    });
  }

  return { status: "ok", messages };
};

const isStringRecord = (value: unknown): value is Readonly<Record<string, string>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
};

// ── finding helpers ─────────────────────────────────────────────────────────

const single = (finding: RiskFinding): EmulationScanResult => ({
  findings: [finding],
  actions: [],
});

const emulationFinding = (
  ruleId:
    | "EMULATION_NOT_CONFIGURED"
    | "EMULATION_SKIPPED_NO_SENDER"
    | "EMULATION_SKIPPED_NO_MESSAGES"
    | "EMULATION_SENDER_UNINITIALISED",
  evidence: Readonly<Record<string, unknown>> = {},
): RiskFinding =>
  createFinding({
    confidence: "low",
    evidence,
    rule: getCoreRule(ruleId),
  });

/**
 * Classifies a TONAPI provider failure (either a metadata fetch or the
 * emulation call itself) into one of three degradation rules:
 *
 *   - HTTP 429 → `EMULATION_RATE_LIMITED` (info; transient, user can retry)
 *   - HTTP 5xx, timeout, or network error (`httpStatus === null`) →
 *     `EMULATION_PROVIDER_DOWN` (low; provider outage, not the user's fault)
 *   - Any other 4xx → `EMULATION_FAILED` (low; likely a request-shape issue)
 *
 * Evidence carries enough breadcrumbs to debug without leaking secrets:
 *   - `source`: which step failed (`metadata_fetch` | `emulate_call`)
 *   - `httpStatus`: the HTTP code (or `null` for timeout / no-response)
 *   - `reason` (emulate_call only): the SDK-error classification before
 *     mapping to a rule — useful when `httpStatus` is null and we have to
 *     distinguish a network error from a malformed SDK response.
 */
const providerFailureFinding = (input: {
  readonly source: "metadata_fetch" | "emulate_call";
  readonly httpStatus: number | null;
  readonly reason?: "rate_limited" | "provider_down" | "bad_request" | "unknown";
}): RiskFinding => {
  const ruleId = classifyProviderFailure(input.httpStatus, input.reason);
  const evidence: Record<string, unknown> = {
    source: input.source,
    httpStatus: input.httpStatus,
  };

  if (input.reason !== undefined) {
    evidence.reason = input.reason;
  }

  return createFinding({
    confidence: "low",
    evidence,
    rule: getCoreRule(ruleId),
  });
};

const classifyProviderFailure = (
  httpStatus: number | null,
  reason: "rate_limited" | "provider_down" | "bad_request" | "unknown" | undefined,
): "EMULATION_RATE_LIMITED" | "EMULATION_PROVIDER_DOWN" | "EMULATION_FAILED" => {
  // Prefer the emulator's pre-classified `reason` when present — it's derived
  // from the same status code but encodes the SDK-error context too (a
  // timeout, for instance, has no HTTP status and is harder to tell apart
  // from a malformed-response error without it).
  if (reason === "rate_limited") {
    return "EMULATION_RATE_LIMITED";
  }

  if (reason === "provider_down") {
    return "EMULATION_PROVIDER_DOWN";
  }

  if (reason === "bad_request") {
    return "EMULATION_FAILED";
  }

  // Otherwise classify by HTTP status alone (the metadata-fetch path).
  if (httpStatus === 429) {
    return "EMULATION_RATE_LIMITED";
  }

  if (httpStatus === null || httpStatus >= 500) {
    return "EMULATION_PROVIDER_DOWN";
  }

  return "EMULATION_FAILED";
};
