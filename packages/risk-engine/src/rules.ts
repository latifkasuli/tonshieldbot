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
    recommendation:
      "Retry in a few seconds. If this persists, lower scan volume or upgrade the TONAPI tier.",
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

  // ── M3 Tier-0 Telegram Bot API degradation rules ──────────────────────────
  // Mirror of the M2 PR-D1 classification table for the Telegram intelligence
  // layer. Fired by `@tonshield/telegram-intel`-driven scanners when Bot API
  // returns an error, the token is absent, or an entity can't be resolved.
  // See docs/research/m3-design.md §5 Tier-0.

  {
    id: "TELEGRAM_BOT_API_NOT_CONFIGURED",
    category: "telegram",
    severity: "info",
    title: "Telegram Bot API disabled in this deployment",
    description:
      "TELEGRAM_INTEL_BOT_TOKEN is not configured in this environment. Telegram-side scans run in static-only mode (handle pattern checks against the watchlist) without Bot API enrichment.",
    recommendation:
      "If you operate this instance, set TELEGRAM_INTEL_BOT_TOKEN to enable Bot API reads (getChat, getUserGifts, getChatGifts, getAvailableGifts).",
    defaultScoreDelta: 5,
  },
  {
    id: "TELEGRAM_BOT_API_RATE_LIMITED",
    category: "telegram",
    severity: "info",
    title: "Telegram Bot API rate-limited",
    description:
      "Telegram returned 429 for this scan's Bot API request. The static-only signal is still authoritative; live enrichment was skipped for this report.",
    recommendation:
      "Retry in a few seconds. If this persists, lower scan volume or distribute load across additional Bot API tokens.",
    defaultScoreDelta: 5,
  },
  {
    id: "TELEGRAM_BOT_API_PROVIDER_DOWN",
    category: "telegram",
    severity: "low",
    title: "Telegram Bot API unreachable",
    description:
      "Telegram returned 5xx or the request timed out / failed at the network layer. Bot API enrichment could not be performed; the static-only signal is the only data in this report.",
    recommendation: "Treat the static-only report with extra caution and retry shortly.",
    defaultScoreDelta: 10,
  },
  {
    id: "TELEGRAM_BOT_API_FAILED",
    category: "telegram",
    severity: "low",
    title: "Telegram Bot API rejected the request",
    description:
      "Telegram returned 4xx (other than 429) for this scan's Bot API request. The static-only signal is still authoritative for this report.",
    recommendation: "Treat the static-only report with extra caution.",
    defaultScoreDelta: 10,
  },
  {
    id: "TELEGRAM_ENTITY_NOT_RESOLVABLE",
    category: "telegram",
    severity: "info",
    title: "Telegram entity could not be resolved",
    description:
      "Bot API returned 'chat not found' for this handle. Either the handle is unclaimed or no longer exists, OR it is a user/bot handle that requires prior context (a forwarded message from the entity, or prior observation) before Bot API can resolve it. Evidence carries a `reason` discriminator distinguishing the two cases.",
    recommendation:
      "If you intended to scan a bot or user by @handle, please forward any message from that bot/user to TON Shield and re-submit, or paste a deep link instead.",
    defaultScoreDelta: 5,
  },
  {
    id: "TELEGRAM_USERNAME_RECENTLY_CHANGED",
    category: "telegram",
    severity: "medium",
    title: "Entity changed its username recently",
    description:
      "TON Shield's previous snapshot of this entity shows a different @username than the current observation. Recent renames correlate with impersonation pivots — the entity may be reusing a freed handle, or laundering a prior reputation history.",
    recommendation:
      "Verify the entity's current identity through an official source before trusting it. Pay particular attention to whether the previous handle matched a well-known project.",
    defaultScoreDelta: 25,
  },
  {
    id: "TELEGRAM_INPUT_RECOGNISED_NOT_SCANNED",
    category: "telegram",
    severity: "info",
    title: "Telegram input recognised but full scanning not yet implemented",
    description:
      "TON Shield identified this input as a Telegram-shaped link (e.g. Mini App URL, t.me/nft/* gift, invite link, channel-id deep link), but the scanner for this specific input kind has not landed yet. The classifier did its work; the deeper checks (gift catalog cross-reference, Mini App content fetch, etc.) are queued in later M3 PRs. Evidence carries the input kind plus a `reason` discriminator explaining why no findings were produced.",
    recommendation:
      "Treat as if no risk signal is available for this link yet. For TON-NFT collectibles, verify ownership at fragment.com directly until M3 PR-6 ships the gift catalog. For Mini App URLs, treat the dApp with the usual scepticism until M3 PR-5 ships content scanning.",
    defaultScoreDelta: 5,
  },
  {
    id: "TELEGRAM_HANDLE_IMPERSONATES_PROJECT",
    category: "telegram",
    severity: "high",
    title: "Handle resembles a well-known project",
    description:
      "The submitted Telegram handle is visually identical or near-identical to a watchlist entry for an established project (wallet, exchange, infrastructure brand, Mini App). TR39 confusables skeleton + Damerau-Levenshtein ≤ 1 or (== 2 with Jaro-Winkler ≥ 0.92) all flag impersonation candidates. Real impersonation campaigns use Cyrillic homoglyphs, single-character typos, and `_support`/`_official` suffixes — all caught here.",
    recommendation:
      "Do not interact with this handle as if it were the real project. Verify through the project's official website. Common-sense reality check: most wallets and exchanges do NOT have Telegram support presences; if you got DM'd, it's almost certainly an impersonator.",
    defaultScoreDelta: 45,
  },
  {
    id: "TELEGRAM_DISPLAY_NAME_HOMOGLYPH",
    category: "telegram",
    severity: "high",
    title: "Display name uses Unicode confusables resembling a known project",
    description:
      "Telegram usernames are ASCII-only by regex, but `first_name`, `last_name`, channel `title`, and `bio` accept full Unicode — and that is where homoglyph attacks land. After NFKC normalisation and TR39 confusables-stripping, the display name's skeleton matches a watchlist brand. Common attacks: Cyrillic `Тоnkeeper`, Greek `Bіnance`, Cherokee `СoinЬase`. Zero-width chars (ZWJ/ZWNJ/ZWSP/BOM) are stripped before comparison so invisible-glyph evasion fails.",
    recommendation:
      "Do not trust the display name. Verify the entity through its canonical handle and official website. Note the handle separately from the display name — Telegram clients render the homoglyph as the brand, but the underlying handle (which is ASCII-only) will not match the legitimate one.",
    defaultScoreDelta: 45,
  },
  {
    id: "TELEGRAM_ENTITY_VERY_NEW",
    category: "telegram",
    severity: "low",
    title: "Entity was created very recently",
    description:
      "TON Shield's ID-age estimator places this entity's creation within the last 30 days. Telegram dialog IDs are issued in roughly-monotonic blocks, so a recent numeric ID is a strong indicator of recency — but database sharding adds ±60 day noise even with current anchor data. This rule pairs with another tier-1 signal (handle/display-name impersonation, suspicious deep link, etc.) — it never fires alone. Legitimate new projects do launch on Telegram every day; the pairing gate is what makes the combined finding actionable.",
    recommendation:
      "Combined with the paired finding, this account is high-risk. Even if the other signal is borderline, recency suggests a freshly-deployed impersonation rather than an established account that happens to have a similar name.",
    defaultScoreDelta: 10,
  },
  {
    id: "TELEGRAM_MINIAPP_CREDENTIAL_PHISHING",
    category: "telegram",
    severity: "critical",
    title: "Mini App page asks for credentials, seed phrase, or login code",
    description:
      "The fetched Mini App page body contains keywords matching the credential-phishing pattern: seed/recovery phrase, mnemonic, private key, Telegram login code, or 2FA / cloud password. Legitimate Mini Apps NEVER prompt for any of these — wallets use OS-level secure stores and Telegram itself never asks for codes inside a third-party Web App. Evidence carries the matched keywords (deduplicated) and the languages they were detected in (per Kaspersky's 2025 Mini App phishing report which documented EN/RU/ES/ZH variants of the same pattern).",
    recommendation:
      "Do not enter any credentials, codes, or recovery phrases. Close the Mini App immediately. If a real wallet asked you for this, it would do so in its native app or the official website, never inside a third-party page.",
    defaultScoreDelta: 80,
  },
  {
    id: "TELEGRAM_MINIAPP_APK_DOWNLOAD",
    category: "telegram",
    severity: "critical",
    title: "Mini App page serves an Android APK download",
    description:
      "The fetched Mini App page body contains a link to an Android Package (`.apk`). The documented FEMITBOT campaign (Bleeping Computer / CTM360, 2024) abused Mini Apps to push fake BBC / NVIDIA / Cineplex / Coreweave APKs, inheriting the parent page's TLS reputation. A legitimate Mini App has no reason to push an APK — Telegram itself is the install path for any first-party functionality.",
    recommendation:
      "Do not install the APK. Close the Mini App immediately. Even if the parent app appears legitimate, an APK download from a Mini App context is a near-certain malware-delivery channel.",
    defaultScoreDelta: 80,
  },
  {
    id: "TELEGRAM_MINIAPP_LURE_LANGUAGE",
    category: "telegram",
    severity: "medium",
    title: "Mini App page uses classic scam-lure language",
    description:
      "The fetched Mini App page body contains airdrop-claim, free-gift, wallet-verification, gift-upgrade, or urgency-pressure phrases consistent with documented Telegram-side scam patterns. Legitimate marketing CAN use similar wording, so this signal alone is medium severity — but combined with credential-phishing keywords, an APK download, or a brand-impersonation finding, it strongly supports the scam interpretation.",
    recommendation:
      "Be sceptical of urgency framing inside Mini Apps. Verify any airdrop / gift / Premium offer through the project's official website or verified channel before connecting a wallet or paying any fee.",
    defaultScoreDelta: 25,
  },
  {
    id: "TELEGRAM_GIFT_TON_ADDRESS_FOR_UPGRADE",
    category: "telegram",
    severity: "high",
    title: "Gift-upgrade page demands a raw TON transfer",
    description:
      "The Mini App page body bundles gift-upgrade lure language (`upgrade your gift`, `upgrade fee`, etc.) with a raw TON wallet address. Legitimate Fragment gift upgrades are paid in Telegram Stars through the in-app flow — never via a raw TON transfer to a wallet address printed on a page. This shape is the documented gift-upgrade-fee fraud pattern (Pavel Durov publicly warned about it; ainvest documented $100K+ losses).",
    recommendation:
      "Do not send TON to the address shown on this page. If you genuinely want to upgrade a Telegram gift, do it through Fragment's official UI or the in-app Stars flow.",
    defaultScoreDelta: 45,
  },
  {
    id: "TELEGRAM_GIFT_LINK_NOT_VERIFIED",
    category: "telegram",
    severity: "low",
    title: "Telegram gift link could not be verified",
    description:
      "Submitted a `t.me/nft/<slug>` collectible link but Telegram's public gift page didn't return the expected markers — most likely the slug doesn't resolve to a live collectible (Telegram 302-redirects unknown slugs to the homepage). Could also indicate a fabricated link in a phishing message. Evidence carries the `reason` discriminator: `slug_marker_missing` (page exists but no gift markers), `slug_marker_mismatch` (page resolves to a DIFFERENT slug than the one submitted — strong fraud signal), `non_gift_page` (request landed on telegram.org or another non-gift page), or `redirected_off_path` (final URL no longer points at `/nft/<slug>`).",
    recommendation:
      "Treat this gift reference as not-yet-verified. If a message claims to be selling, transferring, or upgrading this collectible, do not act on it until you can confirm the slug at fragment.com or via Telegram's in-app gift list.",
    defaultScoreDelta: 10,
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
