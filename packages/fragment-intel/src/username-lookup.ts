import type { FragmentIntelClient } from "./client.ts";
import { classifyTonApiFailure, type TonApiFailure } from "./failure.ts";

/**
 * Pure-ish lookup that turns a Telegram username into a Fragment NFT
 * ownership snapshot:
 *
 *   1. `getDnsInfo("<username>.t.me")` → resolves the TON DNS record
 *      Fragment maintains for every Telegram username NFT. The
 *      response carries the NFT `item` inline (current address +
 *      current owner).
 *   2. `getNftHistoryById(nftAddress, { limit })` → walks the recent
 *      event log on the NFT account. Each `NftItemTransfer` action
 *      records a (sender → recipient, timestamp) tuple. We find the
 *      most recent transfer and return its timestamp.
 *
 * What the caller (the scanner) does with the result:
 *   - `status: "ok"` + `lastTransferAt` within the "recently changed"
 *     threshold → fires `TELEGRAM_USERNAME_FRAGMENT_HANDOFF`.
 *   - `status: "not_found"` (e.g. `bob.t.me` isn't a Fragment
 *     username) → silently skip; no finding.
 *   - `status: "disabled"` → caller should emit
 *     `FRAGMENT_API_NOT_CONFIGURED` exactly once per scan.
 *   - `status: "failed"` → caller emits `FRAGMENT_API_UNAVAILABLE`.
 *
 * Why we don't try to be clever about owner-identity: a single
 * `NftItemTransfer` is enough for the "this changed hands recently"
 * signal. We DON'T attempt to label the new owner as
 * legitimate/illegitimate — that's a separate, harder problem
 * (Fragment marketplace history, prior wallet reputation, etc.) that
 * a future PR can layer on once the basic signal proves valuable.
 */

export type UsernameOwnershipResult =
  | {
      readonly status: "ok";
      readonly ownership: UsernameOwnership;
    }
  | {
      readonly status: "not_found";
      readonly reason: "no_dns_record" | "no_nft_item" | "not_fragment_collection";
    }
  | {
      readonly status: "disabled";
    }
  | {
      readonly status: "failed";
      readonly failure: TonApiFailure;
    };

export interface UsernameOwnership {
  /** Lower-cased username (without `@`) we looked up. */
  readonly username: string;
  /** The NFT item's address as a string (friendly base64url form). */
  readonly nftAddress: string;
  /** Current on-chain owner address (string form). May be `null` for unowned. */
  readonly currentOwnerAddress: string | null;
  /**
   * Unix-seconds timestamp of the most recent `NftItemTransfer` action
   * involving this NFT. `null` when no transfer has been recorded in the
   * inspected window — typically means the NFT has only been minted, not
   * resold.
   */
  readonly lastTransferAt: number | null;
  /** Address of the previous owner per the most recent transfer, if known. */
  readonly previousOwnerAddress: string | null;
  /** When this lookup was performed (Unix-seconds). */
  readonly observedAt: number;
}

/**
 * Default cap on how many history events to fetch per lookup. Recent-
 * handoff detection only needs the most recent NftItemTransfer, so a
 * small window is enough. 25 buys some headroom for unrelated event
 * types (renew, DNS edit) mixed in.
 */
const DEFAULT_HISTORY_LIMIT = 25;

export interface LookupOptions {
  /** Override the per-call history fetch limit. */
  readonly historyLimit?: number;
  /** Inject `now()` for tests. Defaults to `Date.now`. */
  readonly now?: () => Date;
}

export const lookupUsernameOwnership = async (
  client: FragmentIntelClient,
  rawUsername: string,
  options: LookupOptions = {},
): Promise<UsernameOwnershipResult> => {
  if (!client.enabled) {
    return { status: "disabled" };
  }

  const username = normaliseUsername(rawUsername);
  if (username === null) {
    return { status: "not_found", reason: "no_dns_record" };
  }

  const now = options.now ?? (() => new Date());

  const domain = `${username}.t.me`;

  let dnsInfo;
  try {
    dnsInfo = await client.raw.dns.getDnsInfo(domain);
  } catch (error) {
    const failure = classifyTonApiFailure(error);
    if (failure.status === "not_found") {
      return { status: "not_found", reason: "no_dns_record" };
    }
    return { status: "failed", failure };
  }

  const item = dnsInfo.item;
  if (item === undefined) {
    return { status: "not_found", reason: "no_nft_item" };
  }

  // Fragment usernames live in a specific collection. We don't pin its
  // address inline (that's a deploy-time value that has rotated across
  // Fragment mainnet/testnet revisions) — instead we trust the DNS
  // resolver: if t.me's DNS record points at this NFT, it IS the
  // Fragment username. The `not_fragment_collection` status is wired
  // here for future use when we DO want to gate on a known collection.
  const nftAddressStr = item.address.toString();
  const currentOwnerAddress = item.owner?.address.toString() ?? null;

  // Fetch recent history to find the most recent transfer.
  let history;
  try {
    history = await client.raw.nft.getNftHistoryById(item.address, {
      limit: options.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    });
  } catch (error) {
    const failure = classifyTonApiFailure(error);
    if (failure.status === "not_found") {
      // No history yet — treat as ok with no last transfer recorded.
      return {
        status: "ok",
        ownership: {
          username,
          nftAddress: nftAddressStr,
          currentOwnerAddress,
          lastTransferAt: null,
          previousOwnerAddress: null,
          observedAt: Math.floor(now().getTime() / 1000),
        },
      };
    }
    return { status: "failed", failure };
  }

  const latestTransfer = findLatestNftTransfer(history.events);

  return {
    status: "ok",
    ownership: {
      username,
      nftAddress: nftAddressStr,
      currentOwnerAddress,
      lastTransferAt: latestTransfer === null ? null : latestTransfer.timestamp,
      previousOwnerAddress: latestTransfer === null ? null : (latestTransfer.senderAddress ?? null),
      observedAt: Math.floor(now().getTime() / 1000),
    },
  };
};

/**
 * Lowercase + strip `@` + reject anything that doesn't look like a
 * Telegram username. Telegram usernames are 5–32 chars,
 * `[a-zA-Z0-9_]`, can't start with a digit. We accept a slightly
 * broader shape on input (the caller may pass arbitrary text) and
 * normalise to the canonical form.
 *
 * Returns `null` for inputs that aren't plausibly Telegram usernames —
 * the caller treats that as a clean `not_found` rather than a Fragment
 * health failure.
 */
const USERNAME_SHAPE = /^[a-z0-9_]{5,32}$/;

const normaliseUsername = (raw: string): string | null => {
  const trimmed = raw.trim().replace(/^@/, "").toLowerCase();
  return USERNAME_SHAPE.test(trimmed) ? trimmed : null;
};

interface LatestTransfer {
  readonly timestamp: number;
  readonly senderAddress: string | null;
}

/**
 * Scan the event list newest-first and pluck the first NftItemTransfer
 * action. TONAPI returns events grouped (each event has a list of
 * actions), so we flatten before searching.
 */
const findLatestNftTransfer = (
  events: readonly {
    timestamp: number;
    actions: readonly {
      type: string;
      NftItemTransfer?: { sender?: { address: { toString(): string } } };
    }[];
  }[],
): LatestTransfer | null => {
  for (const event of events) {
    for (const action of event.actions) {
      if (action.type !== "NftItemTransfer") continue;
      const transfer = action.NftItemTransfer;
      if (transfer === undefined) continue;
      return {
        timestamp: event.timestamp,
        senderAddress: transfer.sender?.address.toString() ?? null,
      };
    }
  }
  return null;
};
