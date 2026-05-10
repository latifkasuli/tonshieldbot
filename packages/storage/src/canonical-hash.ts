import { createHash } from "node:crypto";
import { assertNever } from "@tonshield/shared";
import type { ScanInput } from "@tonshield/shared";

/**
 * Stable canonical SHA-256 hash of a `ScanInput` for report-level dedup.
 *
 * Two inputs hash equal iff they are expected to produce the same scan
 * report. Per-request fields that do not affect the verdict are stripped
 * before hashing — for example, two TON Connect deep links with the same
 * `manifestUrl` but different `requestId` values dedupe to the same report.
 *
 * For paid emulation we will introduce a separate finer-grained key keyed
 * on canonical outbound message content, because report-level dedup and
 * emulation dedup are related but not identical concerns.
 */
export const canonicalInputHash = (input: ScanInput): string => {
  const canonical = canonicalizeInput(input);
  const json = stableStringify(canonical);

  return createHash("sha256").update(json).digest("hex");
};

interface CanonicalInput {
  readonly kind: ScanInput["kind"];
  readonly key: Readonly<Record<string, unknown>>;
}

const canonicalizeInput = (input: ScanInput): CanonicalInput => {
  switch (input.kind) {
    case "telegram_handle":
      return { kind: input.kind, key: { handle: input.handle.toLowerCase() } };

    case "telegram_url":
      // Hostname is case-insensitive; pathname casing is server-defined and
      // we keep it as-is. URL.toString() already normalizes the rest.
      return { kind: input.kind, key: { url: input.url.toString().toLowerCase() } };

    case "telegram_deeplink":
      // Two deep links targeting the same bot+action+payload should hit the
      // same cache slot — but cache bypass for telegram_* kinds means this
      // is informational. We canonicalise on (target, action, appShortName,
      // payload) so even if the URL grammar varies (case, query order) the
      // dedup key stays stable.
      return {
        kind: input.kind,
        key: {
          target: input.target ?? "",
          action: input.action,
          appShortName: input.appShortName ?? "",
          payload: input.payload ?? "",
        },
      };

    case "telegram_miniapp_url":
      return { kind: input.kind, key: { url: input.url.toString().toLowerCase() } };

    case "telegram_nft_link":
      return { kind: input.kind, key: { slug: input.slug.toLowerCase() } };

    case "tonconnect_link":
      // Drop requestId/returnStrategy: same manifest, same report.
      return { kind: input.kind, key: { manifestUrl: input.manifestUrl.toString() } };

    case "manifest_url":
      return { kind: input.kind, key: { url: input.url.toString() } };

    case "generic_url":
      return { kind: input.kind, key: { url: input.url.toString() } };

    case "ton_address":
      // TODO: canonicalize via Address.parse once classifyInput normalizes
      // EQ.../UQ.../0:... representations to a single form. Currently
      // different friendly forms of the same address dedupe to different
      // reports. Trim and lowercase keeps the obvious whitespace cases
      // working without pulling @ton/core into this package.
      return { kind: input.kind, key: { address: input.address.trim().toLowerCase() } };

    case "boc":
      return { kind: input.kind, key: { boc: input.boc.trim() } };

    case "transaction_json":
      return { kind: input.kind, key: { transaction: canonicalizeUnknown(input.transaction) } };

    case "unknown":
      // Unknowns are still deduped on normalized input so we do not re-scan
      // the same garbage repeatedly. The reason field is excluded — same
      // input that classifies as unknown for any reason should hit the
      // same cache slot.
      return { kind: input.kind, key: { normalized: input.normalized } };

    default:
      return assertNever(input);
  }
};

/**
 * Recursively canonicalizes an unknown JSON-shaped value:
 * - object keys sorted alphabetically (so {a:1,b:2} === {b:2,a:1})
 * - arrays preserved in order (order is semantic in TON Connect message lists)
 * - primitives and null passed through
 *
 * Throws on values JSON cannot represent (functions, symbols, undefined,
 * bigints) — those should never appear in a `ScanInput` payload, and silently
 * tolerating them would hide bugs.
 */
const canonicalizeUnknown = (value: unknown): unknown => {
  if (value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeUnknown(item));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, child]): [string, unknown] => [key, canonicalizeUnknown(child)])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return Object.fromEntries(entries);
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  throw new Error(`Cannot canonicalize value of type ${typeof value}`);
};

/**
 * JSON.stringify with deterministic key ordering. The input is expected to
 * be already canonicalized via `canonicalizeUnknown` (or constructed with
 * literal keys), but we sort defensively at the top level too.
 */
const stableStringify = (value: CanonicalInput): string =>
  JSON.stringify({ kind: value.kind, key: value.key });
