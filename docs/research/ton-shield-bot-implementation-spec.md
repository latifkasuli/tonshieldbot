# TON Shield Bot Implementation Spec

Date: 2026-05-07
Status: Research-backed product and engineering specification
Audience: solo founder/developer with strong Rust, Python, Go, and some TypeScript experience

## 1. Executive Summary

TON Shield is a Telegram-native risk layer for TON interactions. The first version should not try to be a full blockchain security company. It should do one thing extremely well:

> Before a Telegram user signs or trusts a TON interaction, TON Shield explains what it is, who is asking, what will happen, and why it may be risky.

The best MVP wedge is a scanner for:

- Telegram Mini App links and bot handles
- TON Connect deep links and manifests
- TON Connect transaction JSON
- signed or unsigned external message BOCs
- Jetton master and wallet contracts
- wallet addresses and recipient contracts

The initial user-facing product is `@TONShieldBot` plus a Telegram Mini App. The developer-facing product is a small HTTP API that wallets, Mini Apps, directories, and bots can call before showing a signing prompt.

This spec recommends shipping in phases:

1. MVP: TON Connect link, manifest, transaction request, BOC, wallet/address, and Jetton scanner.
2. Early API: embeddable `/risk/*` endpoints for wallets and Mini Apps.
3. Intelligence layer: community reports, allowlists, impersonation detection, labels, phishing feeds.
4. Agent wallet guardrails: policies for TON agentic wallets and Wallet V5 extension changes.

The opportunity exists because TON is now tightly coupled to Telegram Mini Apps, TON Connect is required for blockchain-enabled Mini Apps, Telegram distribution brings non-crypto users into high-risk signing flows, and current protections are fragmented across wallets, explorers, docs, and user education.

## 2. Product Definition

### 2.1 One-line Description

TON Shield is a Telegram bot, Mini App, public report page, and API that scans TON apps, TON Connect requests, Jettons, wallets, and transaction payloads for user-understandable risk.

### 2.2 Primary User Promise

If a user pastes a suspicious Telegram Mini App link, bot handle, TON Connect link, Jetton address, wallet address, transaction request, or BOC, TON Shield returns:

- what the input is
- whether it is known, unknown, verified, suspicious, or malicious
- what action it may cause
- what assets may move
- who receives funds or permissions
- which risk rules triggered
- what the user should do next

### 2.3 MVP Product Surfaces

1. Telegram bot:
   - Accepts text messages, forwarded links, handles, addresses, BOCs, and JSON snippets.
   - Replies with a short risk card.
   - Offers an "Open full report" Mini App button.
   - Offers "Report scam", "Mark false positive", and "Share report" buttons.

2. Telegram Mini App:
   - Rich detailed report view.
   - Paste scanner.
   - Recent scans.
   - Risk explanation and trace visualization.
   - Developer API key page later.

3. Public web report:
   - `https://tonshield.app/r/<scan_id>`
   - Shareable in Telegram, X, support chats, and GitHub issues.
   - Redacts user-specific data unless user opts in.

4. HTTP API:
   - `POST /v1/risk/scan`
   - `POST /v1/risk/tonconnect`
   - `POST /v1/risk/transaction`
   - `POST /v1/risk/jetton`
   - `GET /v1/reports/{id}`

## 3. Strategic Thesis

### 3.1 Why TON Shield Is Timely

TON has unusually strong consumer distribution because Telegram made TON the exclusive blockchain infrastructure for blockchain-enabled Telegram Mini Apps and made TON Connect the required wallet connection protocol for those apps. Toncoin is also used across Telegram platform payments such as Stars, Premium, Ads, Gateway, and creator/developer payouts.

As of this research date, the economic signal is mixed but interesting:

- TON DeFi TVL via DeFiLlama was about USD 89.3M.
- TON stablecoin supply via DeFiLlama was about USD 752.5M.
- USDT on TON was about USD 580.7M.
- USDe on TON was about USD 171.8M.

This implies TON is more attractive as a consumer payments, apps, and distribution ecosystem than as a pure DeFi TVL ecosystem.

### 3.2 Why Security Is A Good Wedge

Telegram-scale distribution brings users who are not trained to read wallet prompts, inspect token contracts, distinguish bot handles, or decode payloads. Attackers exploit this through:

- fake Telegram bots and Mini Apps
- fake airdrops and giveaways
- fake Fragment, Ston.fi, Portals, gift, and marketplace flows
- malicious TON Connect manifests
- transaction prompts that appear harmless but transfer most wallet funds
- fake Jettons with cloned names, tickers, and icons
- phishing Mini Apps embedded inside Telegram's trusted UI
- malware and fake APK distribution through Mini App flows

Current ecosystem responses are mostly:

- wallet-specific warnings
- explorer labels
- token asset lists
- user education
- one-off security reports
- official docs telling developers to build safer flows

The missing product is a reusable risk oracle that sits above individual wallets and below user trust.

### 3.3 Better Positioning Than "Security Scanner"

Do not pitch TON Shield as an abstract scanner. Pitch it as:

> Transaction clarity and scam prevention for Telegram-native TON users.

Developer pitch:

> A one-call risk API for TON Connect, Mini Apps, Jettons, and wallet actions.

Wallet pitch:

> Add Blockaid-like protection for TON without building your own intelligence pipeline.

User pitch:

> Send suspicious TON links to `@TONShieldBot` before you connect your wallet.

## 4. Research Findings

### 4.1 TON Connect Is The Best Initial Attack Surface

TON Connect requests include a manifest URL controlled by the dApp. Wallets display metadata derived from the manifest. Security researchers have shown that this can enable convincing origin or identity forgery if the displayed metadata does not match the actual origin or if the app controls misleading manifest values.

Important TON Connect surfaces:

- `manifestUrl`
- app manifest fields: `url`, `name`, `iconUrl`, `termsOfUseUrl`, `privacyPolicyUrl`
- connection items: `ton_addr`, `ton_proof`
- transaction request fields: `valid_until`, `network`, `from`, `messages`
- message fields: `address`, `amount`, `payload`, `stateInit`, `extra_currency`
- signed result: external message BOC

Risk signals:

- manifest URL hosted on unrelated domain
- manifest `url` does not match manifest URL origin
- icon hosted on a suspicious or unrelated domain
- manifest name impersonates known project
- URL uses typosquatting or homograph-like spelling
- app asks for transaction immediately after wallet connect
- transaction drains a high percentage of wallet balance
- transaction sends to unknown newly deployed recipient
- transaction deploys unknown code using `stateInit`
- transaction uses high message count
- transaction has expired or unusually long `valid_until`
- network mismatch or missing network
- sender address mismatch

### 4.2 TONAPI Makes Emulation Feasible

TONAPI exposes:

- account data
- account events
- Jetton balances and history
- account public key
- traces
- message decoding
- message-to-trace emulation
- message-to-wallet emulation
- message-to-account-event emulation

The important MVP operation is:

- emulate an external message or constructed wallet transfer and summarize resulting actions.

TONAPI emulation can ignore signature checks for preview purposes, which is critical because TON Shield often needs to evaluate an unsigned transaction request before the user signs it.

### 4.3 Jetton Risk Is Important But Should Be Phase 2

Jettons are security-sensitive because anyone can deploy a fake Jetton master or fake Jetton wallet with copied metadata. TON docs explicitly warn services not to trust metadata and to validate the master-wallet relationship.

Useful Jetton checks:

- Is this address a Jetton master or a Jetton wallet?
- If wallet, what master does it claim?
- Does `master.get_wallet_address(owner)` match the wallet address?
- Is the master on a trusted allowlist?
- Is it listed in `tonkeeper/ton-assets`?
- Is it labelled in `ton-studio/ton-labels`?
- Does metadata copy a known token name, symbol, or icon?
- Is admin still mintable or privileged?
- Is holder distribution suspicious?
- Is deploy time recent?
- Is liquidity absent or fake?
- Are transfers or notifications non-standard?

### 4.4 Telegram Mini App Phishing Is Broader Than TON

Telegram Mini Apps are web apps embedded inside Telegram. Reports from security companies describe phishing Mini Apps that:

- impersonate brands
- show fake dashboards and balances
- pressure users with countdowns
- ask for deposits before withdrawals
- ask users to enter Telegram login credentials
- distribute Android APK malware

TON Shield should detect both on-chain and off-chain risk. A Mini App can be dangerous even before a wallet is connected.

### 4.5 Agentic Wallets Are A Future Risk Surface

TON agentic wallets use a split-key model where the operator key can control funds held in the agent wallet. Official docs warn that an active operator key has complete control of the agent wallet balance and that the contracts were not audited at the time of the docs.

Agent wallet features are a strong future narrative, but they are not the first MVP unless you specifically want to chase the AI angle. The better order is:

1. Build TON Connect scanner.
2. Add Wallet V5 extension and delegation detection.
3. Add agentic wallet policy monitoring.

## 5. Threat Model

### 5.1 Protected Users

TON Shield protects:

- normal Telegram users
- airdrop hunters
- creators receiving payments
- Mini App users
- channel admins
- NFT/gift buyers
- stablecoin payment users
- wallet support teams
- Mini App developers integrating TON Connect
- eventually AI/agent wallet users

### 5.2 Adversaries

Adversaries include:

- phishing bot operators
- drainer kit operators
- fake Jetton deployers
- fake giveaway promoters
- compromised Telegram account operators
- fake support accounts
- fake Mini App clones
- malicious dApp developers
- malware distribution campaigns
- opportunistic spam token senders

### 5.3 High-priority Attack Patterns

1. TON Connect identity forgery:
   - A fake app presents a manifest with a trusted name, icon, or URL.

2. Drain transaction:
   - A transaction sends most TON, Jettons, NFTs, or gifts to attacker-controlled addresses.

3. Fake claim:
   - User expects to receive a reward, but signs a transfer away.

4. Fake Jetton:
   - Token copies USDT, NOT, DOGS, HMSTR, Ston.fi assets, or Telegram gift-related metadata.

5. Fake bot or Mini App:
   - Telegram handle resembles known project.

6. Malicious deployment:
   - Transaction deploys a contract with unknown code or suspicious state.

7. Wallet V5 extension attack:
   - Transaction adds, removes, or changes wallet extensions or signature auth mode.

8. Agent wallet over-permission:
   - User funds or grants operator control beyond intended limit.

9. Off-chain credential phishing:
   - Mini App asks for Telegram phone, code, password, seed phrase, private key, or APK install.

### 5.4 Non-goals For MVP

MVP should not attempt:

- formal smart contract auditing
- guaranteed scam detection
- real-time chain-wide mempool defense
- AML-grade fund tracing
- private wallet portfolio tracking
- browser extension protection
- replacing wallets
- launching a token
- on-chain registry
- broad multichain support

## 6. System Architecture

### 6.1 Recommended Architecture

Use a modular service architecture without overcomplicating deployment.

Initial services:

1. Bot service:
   - Telegram Bot API webhook.
   - Parses user inputs.
   - Calls risk API.
   - Sends concise result cards.

2. API service:
   - Public REST API.
   - Auth for developer API keys.
   - Input normalization.
   - Orchestrates scanners.

3. Scanner engine:
   - Runs deterministic rule checks.
   - Calls data providers.
   - Produces normalized report objects.

4. TON adapter:
   - Address parsing.
   - BOC parsing.
   - Cell and payload decoding.
   - TONAPI/Toncenter calls.
   - Jetton validation.

5. Telegram adapter:
   - Bot handle and Mini App link parsing.
   - Bot metadata enrichment.
   - Optional MTProto/TDLib enrichment later.

6. Intelligence database:
   - Known projects.
   - Known domains.
   - Known scam addresses.
   - Known Jettons.
   - User reports.
   - Scan cache.

7. Web/Mini App:
   - Report renderer.
   - Paste scanner.
   - Developer docs later.

8. Background workers:
   - Refresh labels.
   - Pull token lists.
   - Re-score popular reports.
   - Monitor feeds.

### 6.2 Deployment Shape For MVP

Single VPS or small cloud setup:

- API and bot service: one container initially.
- Postgres: persistent state.
- Redis: caching and queues.
- Object storage: screenshots, icons, raw artifacts if needed.
- Background worker: one process.
- Web app: Vercel, Cloudflare Pages, or same VPS.

Simple production stack:

- Caddy or Nginx for TLS.
- Docker Compose for first deployment.
- Postgres backups.
- Sentry or OpenTelemetry.
- Uptime checks.
- Rate limits at reverse proxy and app level.

### 6.3 Language Decision

Build the MVP in TypeScript.

TypeScript is the right default for this product because the most important MVP surfaces are TON Connect parsing, BOC/cell decoding, Telegram bot handling, API orchestration, and Mini App UI. The best-supported libraries for those jobs are already TypeScript-native:

- `@ton/core` for cells, BOCs, addresses, and low-level parsing
- `@ton/ton` for wallet and contract helpers
- `@tonconnect/sdk` for TON Connect request handling
- `@ton-api/client` for TONAPI integration
- `grammy` for the Telegram bot
- React for the Telegram Mini App and public report UI

Recommended MVP stack:

- Backend API, bot, TON parser, and risk engine: TypeScript.
- Frontend/Mini App: TypeScript + React.
- Database: Postgres.
- Cache/queue: Redis.
- Runtime: Node.js 24+.

Do not split the MVP across Go, Python, or Rust. Keep one language, one type system, one package graph, and one deployment path until the product behavior is proven.

## 7. Input Classification

The scanner starts by classifying arbitrary user input.

### 7.1 Accepted Inputs

Text examples:

- `@SomeBot`
- `https://t.me/somebot/app?startapp=...`
- `https://t.me/somebot?start=...`
- `https://t.me/somebot?startattach=...`
- `tc://?v=2&id=...&r=...&ret=...`
- `ton://transfer/...`
- `https://app.example.com/tonconnect-manifest.json`
- `https://app.example.com`
- `EQ...`
- `UQ...`
- `0:<64 hex chars>`
- base64 BOC
- JSON TON Connect transaction
- Jetton master address
- Jetton wallet address
- wallet address

### 7.2 Classifier Output

```json
{
  "input_type": "tonconnect_link",
  "normalized": {
    "manifest_url": "https://example.com/tonconnect-manifest.json",
    "return_url": "none",
    "request_id": "..."
  },
  "confidence": 0.98,
  "warnings": []
}
```

### 7.3 Classification Order

1. Trim and detect JSON.
2. Detect TON Connect URI.
3. Detect Telegram URL or handle.
4. Detect TON address.
5. Detect manifest URL.
6. Detect generic URL.
7. Detect base64 BOC.
8. Fallback to text search.

### 7.4 Safety Rules For Input Fetching

Fetching arbitrary user URLs is dangerous. Implement SSRF protections from day one.

Rules:

- Only fetch `http` and `https`.
- Prefer `https`; mark `http` high risk.
- Block private IP ranges.
- Block localhost and link-local addresses.
- Resolve DNS server-side and validate resolved IPs before connect.
- Re-check IP after redirects.
- Limit redirects to 3.
- Timeout aggressively.
- Limit response size.
- Do not execute JavaScript in MVP.
- Do not download APKs or large binaries.
- Store hashes of fetched content, not full content, unless needed.

## 8. TON Connect Scanner

### 8.1 TON Connect Deep Link Parsing

Example format:

```text
tc://?v=2&id=<request_id>&r=<url_encoded_connect_request>&ret=<return_strategy>
```

The `r` parameter contains a JSON connection request:

```json
{
  "manifestUrl": "https://example.com/tonconnect-manifest.json",
  "items": [
    { "name": "ton_addr" },
    { "name": "ton_proof", "payload": "nonce-or-token" }
  ]
}
```

Parser behavior:

- Parse URI.
- Extract version.
- Extract request ID.
- URL-decode `r`.
- Parse JSON.
- Validate `manifestUrl` as absolute HTTPS URL.
- Validate item list.
- Fetch manifest if safe.
- Score identity and metadata.

### 8.2 Manifest Fetching

TON Connect app manifest required fields:

- `url`
- `name`
- `iconUrl`

Optional fields:

- `termsOfUseUrl`
- `privacyPolicyUrl`

Manifest checks:

- Is manifest URL valid and absolute?
- Is manifest URL HTTPS?
- Is manifest hosted at `/<root>/tonconnect-manifest.json`?
- Is manifest accessible with GET?
- Does manifest parse as JSON?
- Are required fields present?
- Is `url` HTTPS?
- Does `url` origin match `manifestUrl` origin?
- Does `iconUrl` use PNG or ICO?
- Does icon fetch return image content?
- Are policy URLs present?
- Are policy URLs on same or expected origin?
- Does name collide with a known project?
- Does URL domain collide with a known project?
- Is domain newly registered? This may require external enrichment.
- Is domain in a phishing feed?
- Is host a raw GitHub, generic storage, or suspicious CDN?
- Is domain punycode?
- Does display name contain confusables?

### 8.3 Manifest Risk Rules

Rule examples:

```json
{
  "id": "TC_MANIFEST_URL_ORIGIN_MISMATCH",
  "severity": "high",
  "title": "Manifest claims a different app domain",
  "description": "The TON Connect manifest is hosted on one origin but claims another app URL.",
  "evidence": {
    "manifest_url_origin": "https://evil.example",
    "declared_app_origin": "https://ton.org"
  }
}
```

```json
{
  "id": "TC_MANIFEST_IMPERSONATES_KNOWN_PROJECT",
  "severity": "critical",
  "title": "App name resembles a known TON project",
  "description": "The manifest name is visually similar to a known project but the domain is not recognized.",
  "evidence": {
    "manifest_name": "Tonkeeper Rewards",
    "matched_project": "Tonkeeper",
    "domain": "tonkeeper-reward.example"
  }
}
```

### 8.4 TON Connect Transaction Request Parsing

TON Connect transaction payload fields:

- `valid_until` or `validUntil` depending on SDK surface
- `network`
- `from`
- `messages`

Message fields:

- `address`
- `amount`
- `payload`
- `stateInit`
- `extra_currency`

Normalize both camelCase and snake_case inputs because docs and examples vary across SDK layers.

Normalized structure:

```json
{
  "valid_until": 1770000000,
  "network": "-239",
  "from": "0:...",
  "messages": [
    {
      "to": "EQ...",
      "amount_nano": "20000000",
      "payload_boc": "...",
      "state_init_boc": null,
      "extra_currency": {}
    }
  ]
}
```

### 8.5 Transaction Risk Rules

High-signal rules:

- `TX_SENDS_HIGH_PERCENT_OF_BALANCE`
- `TX_SENDS_ALL_OR_NEAR_ALL_TON`
- `TX_SENDS_TO_KNOWN_SCAM_ADDRESS`
- `TX_SENDS_TO_UNKNOWN_NEW_ADDRESS`
- `TX_SENDS_TO_UNINITIALIZED_CONTRACT`
- `TX_DEPLOYS_UNKNOWN_CONTRACT`
- `TX_HAS_STATE_INIT`
- `TX_HAS_OPAQUE_PAYLOAD`
- `TX_COMMENT_CLAIMS_REWARD_BUT_SENDS_FUNDS`
- `TX_VALID_UNTIL_TOO_LONG`
- `TX_VALID_UNTIL_EXPIRED`
- `TX_NETWORK_MISSING`
- `TX_NETWORK_MISMATCH`
- `TX_FROM_MISMATCH`
- `TX_TOO_MANY_MESSAGES`
- `TX_CONTAINS_NFT_TRANSFER`
- `TX_CONTAINS_JETTON_TRANSFER`
- `TX_CONTAINS_WALLET_V5_EXTENSION_CHANGE`
- `TX_CONTAINS_SIGNATURE_AUTH_CHANGE`
- `TX_EXTRA_CURRENCY_USED`

Critical MVP rule:

If a transaction is triggered from a "claim", "airdrop", "reward", "gift", or "receive" flow but sends assets away from the user, flag it as critical.

### 8.6 Human-readable Transaction Preview

Every transaction report should include a plain-language preview:

```text
This request appears to send 14.82 TON from your wallet to an unknown address.
It does not appear to claim or receive funds.
The recipient is not labelled and the app identity is suspicious.
Do not sign unless you fully trust this app.
```

For Jettons:

```text
This request sends 250 USDT from your Jetton wallet to EQ...
The USDT master contract matches the known USDT on TON asset list.
The recipient is unknown.
```

For unknown payloads:

```text
This request calls an unknown smart contract with an opaque payload.
TON Shield could not decode the operation. Treat this as risky unless the app is trusted.
```

## 9. BOC And Message Scanner

### 9.1 Scope

Users may paste a BOC after signing, from wallet logs, from a developer console, or from a suspicious app. TON Shield should parse and decode it where possible.

### 9.2 BOC Processing

Use `@ton/core`:

- `Cell.fromBase64`
- `loadMessage`
- `beginParse`
- opcode extraction
- address extraction

Processing steps:

1. Validate base64.
2. Parse Cell.
3. Try `loadMessage`.
4. Detect external vs internal message.
5. Extract destination, source if present, body, init.
6. Decode wallet transfer if standard wallet.
7. Decode outgoing internal messages if possible.
8. Call TONAPI `decodeMessage`.
9. Call TONAPI emulation if enough context.
10. Produce trace summary.

### 9.3 Emulation Flow

For unsigned TON Connect transaction JSON:

1. Parse sender address.
2. Fetch wallet seqno and public key if needed.
3. Construct wallet transfer with dummy key.
4. Wrap as external message.
5. Call TONAPI emulation with signature check ignored.
6. Summarize trace.

For signed BOC:

1. Submit BOC to TONAPI decode.
2. Emulate message to trace if not yet executed.
3. If executed, locate trace by message hash.
4. Summarize actual or predicted outcomes.

### 9.4 Trace Summarization

Trace summary fields:

- success/failure
- bounced messages
- total fees
- total TON delta by address
- Jetton transfers
- NFT transfers
- deployed contracts
- destroyed contracts
- wallet extension changes
- unknown opcodes
- high-risk recipients

Do not rely only on high-level TONAPI actions for security logic. TONAPI docs note that account event actions are meant for display and may change. Use them for UX, but keep your own deterministic rule checks where possible.

## 10. Jetton Scanner

### 10.1 Supported Inputs

- Jetton master address
- Jetton wallet address
- wallet address with Jetton balance
- TON Connect transaction payload containing Jetton transfer
- BOC containing Jetton transfer

### 10.2 Jetton Standard Basics

Important opcodes:

- `0x0f8a7ea5`: Jetton transfer
- `0x7362d09c`: transfer notification
- `0x178d4519`: internal transfer
- `0x595f07bc`: burn
- `0x7bdd97de`: burn notification
- `0xd53276db`: excesses

Important get methods:

- `get_jetton_data()`
- `get_wallet_data()`
- `get_wallet_address(owner_address)`

### 10.3 Jetton Master Checks

For a Jetton master:

- Fetch `get_jetton_data()`.
- Parse total supply.
- Parse mintable flag.
- Parse admin address.
- Parse metadata.
- Fetch account info.
- Check code verification if available.
- Check trusted lists.
- Check labels.
- Check holder count if provider supports it.
- Check deploy age.
- Check recent transfer patterns.

### 10.4 Jetton Wallet Checks

For a Jetton wallet:

1. Call `get_wallet_data()`.
2. Extract:
   - balance
   - owner
   - master
   - wallet code
3. Call master `get_wallet_address(owner)`.
4. Verify returned address equals the wallet address.
5. If mismatch, mark critical.

### 10.5 Fake Jetton Detection

Risk signals:

- name matches known asset but master address differs
- symbol matches known asset but master address differs
- icon URL matches or copies known asset
- metadata is incomplete
- metadata is mutable or hosted on suspicious domain
- mintable with unknown admin
- admin address is not known project
- supply distribution is concentrated
- no liquidity or fake liquidity
- very recent deployment
- no trusted labels
- suspicious inbound spam distribution

### 10.6 Jetton Report Example

```json
{
  "type": "jetton",
  "address": "EQ...",
  "classification": "suspicious_clone",
  "display_name": "Tether USD",
  "symbol": "USDT",
  "risk_score": 86,
  "verdict": "high",
  "summary": "This token uses USDT-like metadata but does not match the known USDT master address on TON.",
  "checks": [
    {
      "id": "JETTON_SYMBOL_COLLISION",
      "severity": "critical",
      "status": "fail"
    },
    {
      "id": "JETTON_NOT_IN_TRUSTED_ASSETS",
      "severity": "medium",
      "status": "fail"
    }
  ]
}
```

## 11. Telegram Bot And Mini App Scanner

### 11.1 Telegram URL Types

Handle:

```text
@SomeBot
```

Bot URL:

```text
https://t.me/SomeBot
```

Mini App direct link:

```text
https://t.me/SomeBot/appname?startapp=ABC
```

Attachment/start link:

```text
https://t.me/SomeBot?startattach=ABC
```

Bot start link:

```text
https://t.me/SomeBot?start=ABC
```

### 11.2 Mini App Launch Parameters

Mini Apps receive launch parameters such as:

- `tgWebAppVersion`
- `tgWebAppData`
- `tgWebAppPlatform`
- `tgWebAppThemeParams`
- `tgWebAppStartParam`

The start parameter can be used for report deep links:

```text
https://t.me/TONShieldBot/app?startapp=report_<id>
```

Start parameter restrictions:

- max 512 characters
- alphanumeric, underscore, and hyphen
- use base64url or short IDs for complex payloads

### 11.3 Bot Metadata Enrichment

Using Bot API:

- `getChat` can retrieve basic public chat information for handles that are accessible.
- Bot API metadata is limited.

Using MTProto/TDLib later:

- richer flags may be available depending on API surface
- public usernames
- verification flags
- scam/fake flags in some Telegram client libraries
- profile photo history
- linked chat/channel data

MVP should not depend on unofficial or fragile Telegram metadata. Treat it as enrichment only.

### 11.4 Telegram Risk Rules

- `TG_HANDLE_IMPERSONATES_KNOWN_PROJECT`
- `TG_HANDLE_RECENT_OR_LOW_SIGNAL`
- `TG_HANDLE_NOT_MATCHING_MANIFEST_DOMAIN`
- `TG_MINIAPP_START_PARAM_OPAQUE`
- `TG_MINIAPP_ASKS_FOR_LOGIN_CODE`
- `TG_MINIAPP_PROMOTES_APK_DOWNLOAD`
- `TG_MINIAPP_CLAIMS_REWARD`
- `TG_MINIAPP_USES_URGENCY_LANGUAGE`
- `TG_LINK_TARGETS_UNKNOWN_BOT`

MVP can implement static link and handle heuristics without crawling the Mini App UI. Later, add safe screenshot/browser sandbox analysis for public URLs.

## 12. Address And Contract Scanner

### 12.1 Address Normalization

Accept:

- raw format: `0:<64 hex>`
- user-friendly bounceable
- user-friendly non-bounceable
- testnet flag if present

Normalize to:

```json
{
  "raw": "0:...",
  "friendly_bounceable": "EQ...",
  "friendly_non_bounceable": "UQ...",
  "workchain": 0,
  "hash": "..."
}
```

### 12.2 Account Checks

Fetch:

- account status
- balance
- interfaces
- code hash
- last activity
- labels
- DNS reverse records
- Jetton balances
- NFTs if relevant
- recent events
- traces

Classify:

- wallet
- wallet v3/v4/v5
- Jetton master
- Jetton wallet
- NFT collection
- NFT item
- DNS collection/item
- multisig
- staking/nominator
- DEX contract
- unknown contract
- uninitialized account

### 12.3 Contract Verification

Use:

- TON verifier where available
- code hash registry
- known standard contract code hashes
- explorer labels
- project allowlists

Risk signals:

- unknown code with high value
- recently deployed unknown code
- unverified code claiming known brand
- code hash associated with drainer kits
- contract receives many victims' funds
- contract fans out to exchange or mixer-like endpoints

## 13. Risk Engine

### 13.1 Design Goals

The risk engine must be:

- deterministic
- explainable
- auditable
- easy to add rules to
- safe against provider outages
- conservative with critical warnings
- honest about uncertainty

Do not make a black-box "AI says scam" product. Users and wallet teams need to know why a warning appears.

### 13.2 Verdict Levels

Use five levels:

- `safe`: known, expected, low-risk interaction
- `info`: no obvious risk, but limited signal
- `caution`: unknown or mildly suspicious
- `high`: strong risk indicators
- `critical`: likely malicious or dangerous

Optional:

- `unknown`: insufficient data
- `error`: could not analyze

### 13.3 Score Model

Represent risk score from 0 to 100.

Suggested mapping:

- 0-19: safe
- 20-39: info
- 40-59: caution
- 60-79: high
- 80-100: critical

Scoring should be rule-driven:

```json
{
  "base_score": 0,
  "rules": [
    { "id": "KNOWN_GOOD_PROJECT", "delta": -30 },
    { "id": "MANIFEST_ORIGIN_MISMATCH", "delta": 45 },
    { "id": "SENDS_97_PERCENT_BALANCE", "delta": 60 }
  ],
  "final_score": 100
}
```

Clamp score to 0-100.

### 13.4 Rule Schema

```json
{
  "id": "TX_SENDS_NEAR_FULL_BALANCE",
  "version": 1,
  "category": "transaction",
  "severity": "critical",
  "title": "Transaction sends almost all wallet balance",
  "description": "The transaction appears to transfer most of the sender's TON balance.",
  "recommendation": "Do not sign unless you intentionally want to empty this wallet.",
  "evidence": {
    "balance_nano": "15300000000",
    "send_amount_nano": "14800000000",
    "percentage": 96.7
  },
  "confidence": 0.96
}
```

### 13.5 Rule Categories

- `identity`
- `telegram`
- `tonconnect`
- `transaction`
- `emulation`
- `jetton`
- `nft`
- `wallet`
- `contract`
- `domain`
- `community`
- `provider`

### 13.6 Confidence

Separate severity from confidence.

Example:

- High severity, low confidence: unknown opaque payload to unknown contract.
- Medium severity, high confidence: no privacy policy in manifest.
- Critical severity, high confidence: known scam address recipient.

### 13.7 Handling Uncertainty

Never say "safe" unless there is positive evidence.

Bad:

```text
This is safe.
```

Better:

```text
No high-risk behavior was detected. The app is still unknown, so use caution.
```

## 14. Data Model

### 14.1 Core Tables

`scans`

```sql
create table scans (
  id uuid primary key,
  created_at timestamptz not null default now(),
  input_hash text not null,
  input_type text not null,
  normalized_input jsonb not null,
  verdict text not null,
  risk_score int not null,
  confidence numeric not null,
  summary text not null,
  report jsonb not null,
  user_id bigint,
  is_public boolean not null default true
);
```

`scan_artifacts`

```sql
create table scan_artifacts (
  id uuid primary key,
  scan_id uuid not null references scans(id),
  artifact_type text not null,
  url text,
  content_hash text,
  content_type text,
  size_bytes int,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
```

`projects`

```sql
create table projects (
  id uuid primary key,
  slug text unique not null,
  name text not null,
  status text not null,
  website_url text,
  telegram_handle text,
  ton_dns text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

`project_identities`

```sql
create table project_identities (
  id uuid primary key,
  project_id uuid not null references projects(id),
  identity_type text not null,
  value text not null,
  status text not null,
  source text not null,
  metadata jsonb not null default '{}',
  unique(identity_type, value)
);
```

Identity types:

- `domain`
- `telegram_handle`
- `ton_address`
- `jetton_master`
- `nft_collection`
- `ton_dns`
- `github_org`
- `x_handle`

`addresses`

```sql
create table addresses (
  raw_address text primary key,
  workchain int not null,
  account_type text,
  status text,
  labels jsonb not null default '[]',
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  metadata jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
```

`jettons`

```sql
create table jettons (
  master_address text primary key,
  name text,
  symbol text,
  decimals int,
  image_url text,
  admin_address text,
  mintable boolean,
  verification_status text not null default 'unknown',
  trusted_source text,
  metadata jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
```

`domains`

```sql
create table domains (
  domain text primary key,
  normalized_domain text not null,
  punycode_domain text,
  risk_status text not null default 'unknown',
  labels jsonb not null default '[]',
  metadata jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
```

`user_reports`

```sql
create table user_reports (
  id uuid primary key,
  created_at timestamptz not null default now(),
  reporter_telegram_id bigint,
  target_type text not null,
  target_value text not null,
  reason text not null,
  evidence text,
  status text not null default 'new',
  moderator_notes text
);
```

`api_keys`

```sql
create table api_keys (
  id uuid primary key,
  owner_telegram_id bigint,
  name text not null,
  key_hash text not null unique,
  scopes text[] not null,
  rate_limit_per_minute int not null default 60,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
```

### 14.2 Cache Keys

Use Redis:

- `scan:{input_hash}` -> scan ID/report
- `manifest:{url_hash}` -> fetched manifest
- `account:{address}` -> account info
- `jetton:{master}` -> jetton info
- `domain:{domain}` -> domain metadata
- `labels:tonstudio:version` -> current labels version

Suggested TTLs:

- manifest: 1 hour
- account: 1-5 minutes
- labels: 1 day
- known projects: 5 minutes
- scan report: permanent in Postgres, cache 1 day

## 15. API Specification

### 15.1 Common Response

```json
{
  "scan_id": "uuid",
  "verdict": "high",
  "risk_score": 74,
  "confidence": 0.88,
  "summary": "This TON Connect request uses suspicious app identity metadata and sends funds to an unknown address.",
  "input_type": "tonconnect_link",
  "normalized_input": {},
  "findings": [],
  "actions": [],
  "report_url": "https://tonshield.app/r/uuid",
  "created_at": "2026-05-07T10:00:00Z"
}
```

### 15.2 `POST /v1/risk/scan`

General scanner endpoint.

Request:

```json
{
  "input": "tc://?v=2&id=...",
  "context": {
    "user_wallet": "EQ...",
    "source": "telegram_bot",
    "telegram_handle": "@SomeBot"
  },
  "options": {
    "fetch_remote": true,
    "emulate": true,
    "public_report": true
  }
}
```

Response: common response.

### 15.3 `POST /v1/risk/tonconnect`

Request:

```json
{
  "link": "tc://?v=2&id=...",
  "transaction": {
    "valid_until": 1770000000,
    "messages": []
  },
  "sender_address": "EQ...",
  "manifest_url": "https://example.com/tonconnect-manifest.json"
}
```

At least one of `link`, `transaction`, or `manifest_url` is required.

### 15.4 `POST /v1/risk/transaction`

Request:

```json
{
  "transaction": {
    "valid_until": 1770000000,
    "network": "-239",
    "from": "EQ...",
    "messages": [
      {
        "address": "EQ...",
        "amount": "1000000000",
        "payload": "base64boc"
      }
    ]
  },
  "sender_address": "EQ...",
  "app_context": {
    "manifest_url": "https://example.com/tonconnect-manifest.json",
    "telegram_handle": "@ExampleBot"
  }
}
```

### 15.5 `POST /v1/risk/boc`

Request:

```json
{
  "boc": "te6cck...",
  "context": {
    "sender_address": "EQ..."
  },
  "options": {
    "emulate": true
  }
}
```

### 15.6 `POST /v1/risk/jetton`

Request:

```json
{
  "address": "EQ...",
  "expected_symbol": "USDT",
  "owner_address": "EQ..."
}
```

### 15.7 `GET /v1/reports/{id}`

Returns public report. If private, requires owner auth.

### 15.8 API Auth

MVP:

- Telegram bot calls internal API without public key.
- Public API starts unauthenticated but heavily rate-limited.

Post-MVP:

- API keys for wallets and Mini Apps.
- HMAC signing for higher-trust partners.
- Per-key rate limits.
- Abuse monitoring.

## 16. Bot UX Specification

### 16.1 Bot Commands

- `/start`: explain scanner and show Mini App button
- `/scan`: prompt user to paste input
- `/report`: report scam or false positive
- `/help`: supported inputs and safety disclaimer
- `/api`: developer API waitlist/docs

### 16.2 Bot Message Flow

User:

```text
https://t.me/FakeRewardsBot/app?startapp=claim
```

Bot:

```text
Risk: High

This looks like a Telegram Mini App link. The bot handle resembles known reward/gift phishing patterns and is not linked to a known TON project.

Do not connect your wallet unless you verified this from the official project channel.
```

Buttons:

- `Open full report`
- `Report scam`
- `Share`

### 16.3 TON Connect Flow

User:

```text
tc://?v=2&id=...
```

Bot:

```text
Risk: Critical

This TON Connect request claims to be "Fragment" but its manifest is hosted on an unrelated domain.

If signed, the related transaction may send most of your TON to an unknown address.
```

### 16.4 Report Scam Flow

1. User taps `Report scam`.
2. Bot asks reason:
   - fake app
   - fake token
   - wallet drain
   - phishing
   - malware
   - other
3. User optionally adds evidence.
4. Store report as unverified.
5. If many independent reports target same artifact, increase community risk with low/moderate confidence.

### 16.5 Bot Abuse Controls

- Per-user rate limit.
- Per-chat rate limit.
- Block huge messages.
- Do not fetch unlimited URLs.
- Spam report throttling.
- Reputation weighting for reports.
- Admin moderation queue.

## 17. Mini App UX Specification

### 17.1 Main Screens

1. Home scanner:
   - paste input
   - recent examples
   - "What can I scan?"

2. Report summary:
   - verdict
   - score
   - plain-language summary
   - top findings
   - recommended action

3. Identity tab:
   - manifest
   - domain
   - Telegram bot/channel
   - known project match

4. Transaction tab:
   - decoded messages
   - asset deltas
   - recipients
   - payloads
   - emulation result

5. Token tab:
   - Jetton metadata
   - trusted list status
   - clone warnings
   - master-wallet verification

6. Raw data tab:
   - JSON report
   - provider data
   - useful for developers

7. Report/appeal:
   - submit scam report
   - appeal false positive

### 17.2 Design Principles

- Mobile-first.
- Telegram theme-aware.
- No scary jargon without explanation.
- Show "why" for every warning.
- Do not bury the key action.
- Make report shareable.
- Let developers inspect raw details.

### 17.3 Result Card Layout

Fields:

- verdict badge
- risk score
- confidence
- one-sentence summary
- "What this wants to do"
- "Why we flagged it"
- "What you should do"
- report metadata

Example:

```text
Critical risk
Score: 94/100
Confidence: High

What this wants to do:
Send 96.7% of your TON balance to an unknown address.

Why we flagged it:
- App manifest claims a known brand but is hosted elsewhere.
- Recipient is not linked to the claimed project.
- The transaction behaves like known TON drainer samples.

Recommendation:
Do not sign this request.
```

## 18. Intelligence Sources

### 18.1 First-party Database

Build your own curated database for:

- known projects
- official domains
- official Telegram handles
- official Jetton masters
- known scam addresses
- known phishing domains
- known drainer code hashes
- false positive decisions

Start manually. Do not wait for automation.

### 18.2 Public Sources

Useful sources:

- TON official docs
- TON Connect docs/spec
- TONAPI docs
- TON verifier
- Tonviewer/Tonscan
- `tonkeeper/ton-assets`
- `ton-studio/ton-labels`
- TON DNS records
- project official websites and Telegram channels
- GitHub issues for phishing reports
- security research from SlowMist, Neplox, Kaspersky, CTM360, BleepingComputer

### 18.3 Provider Strategy

MVP providers:

- TONAPI for accounts, emulation, traces, events.
- TON Center or direct SDK as fallback for get methods.
- GitHub raw fetch for public lists.
- Your own curated YAML/JSON files for known projects.

Post-MVP:

- multiple indexers
- domain intelligence API
- phishing feed API
- screenshot/browser sandbox
- partner wallet telemetry

### 18.4 Provider Reliability

For every provider response store:

- provider name
- endpoint
- fetched_at
- response hash
- cache status
- error if any

Reports should say when risk is limited by provider outage.

## 19. Known Project Registry

### 19.1 Registry Format

Start with a repository file:

```yaml
projects:
  - slug: tonkeeper
    name: Tonkeeper
    status: trusted
    domains:
      - tonkeeper.com
    telegram_handles:
      - tonkeeper
    addresses: []
    jetton_masters: []
    notes: "Wallet project. Add only verified official identities."
```

### 19.2 Registry Rules

- Every identity needs a source.
- Do not accept community reports as trusted identity without review.
- Preserve history.
- Allow project appeals.
- Separate "known" from "trusted".
- Separate "verified official" from "popular but unaudited".

### 19.3 Initial Projects To Curate

Start with high-impersonation-risk names:

- Telegram
- Fragment
- Wallet
- Tonkeeper
- MyTonWallet
- Ston.fi
- DeDust
- Notcoin
- DOGS
- Hamster Kombat
- Blum
- Portals
- Getgems
- TON Society
- TON Foundation
- Tether USDT on TON
- Ethena USDe on TON

## 20. Implementation Plan

### 20.1 Week 1: Foundation

Deliverables:

- repo scaffold
- bot webhook
- API service
- Postgres schema
- input classifier
- basic report schema
- public report page skeleton
- safe URL fetcher

Technical tasks:

- Choose TypeScript runtime: Node.js with Fastify or Hono.
- Add `@ton/core`, `@ton/ton`, `@ton-api/client`.
- Add `grammy` or `telegraf`.
- Add migrations.
- Add test fixtures.

### 20.2 Week 2: TON Connect And Manifest Scanner

Deliverables:

- parse TON Connect deep links
- fetch manifests safely
- manifest identity rules
- known project registry v0
- bot result cards
- report page identity section

Rules:

- manifest URL invalid
- manifest fetch failed
- manifest origin mismatch
- missing fields
- suspicious hosting
- known project impersonation
- icon mismatch
- policy missing

### 20.3 Week 3: Transaction And BOC Scanner

Deliverables:

- parse TON Connect transaction JSON
- parse BOCs
- decode basic TON transfer comments
- decode Jetton transfer opcode
- construct emulation requests
- summarize TONAPI trace

Rules:

- high balance drain
- unknown recipient
- stateInit deployment
- opaque payload
- expired/long validity
- network mismatch
- multiple messages

### 20.4 Week 4: Jetton Scanner

Deliverables:

- Jetton master detection
- Jetton wallet detection
- master-wallet verification
- token metadata checks
- trusted asset list import
- clone detection v0

Rules:

- fake wallet relationship
- known symbol collision
- unknown mintable token
- metadata suspicious
- trusted list missing

### 20.5 Week 5: Public Beta Polish

Deliverables:

- Mini App report UX
- report sharing
- user report flow
- admin moderation view
- rate limiting
- caching
- error handling
- basic observability

### 20.6 Week 6: Developer API

Deliverables:

- API docs
- API keys
- wallet/Mini App integration examples
- sample middleware
- webhook or callback option
- launch blog/demo

## 21. Testing Strategy

### 21.1 Unit Tests

Test:

- input classification
- address parsing
- TON Connect URI decoding
- manifest validation
- SSRF guard
- transaction normalization
- BOC parsing
- opcode decoding
- rule scoring
- report generation

### 21.2 Fixtures

Create fixtures:

- valid Tonkeeper-like manifest
- manifest origin mismatch
- invalid manifest JSON
- fake Fragment manifest
- simple TON transfer
- high-balance drain transfer
- Jetton transfer
- fake Jetton metadata
- Jetton wallet/master mismatch
- Wallet V5 extension action fixture later

### 21.3 Integration Tests

Test against:

- TONAPI sandbox/testnet where possible
- known public addresses
- known Jetton masters
- testnet contracts

Mock provider responses for deterministic tests.

### 21.4 Security Tests

Test:

- private IP URL fetch blocked
- redirect to private IP blocked
- large response blocked
- slowloris/timeout
- invalid base64
- huge JSON
- deeply nested JSON
- malicious unicode domains
- punycode domains
- path traversal in report IDs
- API rate limits

### 21.5 Golden Report Tests

For important cases, snapshot the final report JSON. This prevents accidental changes in verdicts and user-facing language.

## 22. Observability

### 22.1 Metrics

Track:

- scans per input type
- verdict distribution
- rule trigger counts
- provider latency
- provider error rate
- emulation success rate
- bot response time
- report shares
- user reports submitted
- false positive appeals
- API key usage

### 22.2 Logs

Structured logs:

- scan ID
- input hash, not raw sensitive input
- user ID hash if possible
- provider calls
- rule IDs triggered
- errors

### 22.3 Alerts

Alert on:

- provider outage
- bot webhook failure
- high API error rate
- DB connection failure
- sudden spike in critical scans
- sudden spike in one reported domain/address

## 23. Privacy And Abuse

### 23.1 Privacy Principles

- Do not publish user wallet address by default when scanning a transaction unless it is already required in the pasted public artifact.
- Hash raw input for deduplication.
- Redact Telegram user data.
- Allow private scans later.
- Do not store seed phrases; detect and warn if pasted, then discard.
- Do not ask users to connect wallet for MVP scanning.

### 23.2 Sensitive Input Detection

If user pastes likely seed phrase or private key:

- do not store it
- immediately warn user to move funds
- explain that TON Shield never needs seed phrases

### 23.3 Report Abuse

Risks:

- competitors marking projects as scams
- attackers probing detection
- spam reports
- phishing links in evidence

Mitigations:

- reports are unverified by default
- reputation weighting
- moderation queue
- do not auto-critical solely from reports
- sanitize all URLs
- avoid clickable dangerous links in admin UI

## 24. Monetization

### 24.1 Free User Product

Keep consumer scanning free. It builds trust and data.

### 24.2 Paid Developer API

Potential pricing:

- free: 100 scans/day
- indie: 10k scans/month
- pro wallet/Mini App: higher volume, SLA, custom allowlists
- enterprise: wallet integration, feed access, support

### 24.3 Other Revenue

- security review reports for TON Mini Apps
- verified project profile pages
- scam monitoring for brands
- Telegram channel/community protection bot
- API for app directories

Avoid pay-to-remove-risk. That destroys credibility.

## 25. Launch Strategy

### 25.1 Demo To Build

The launch demo should show:

1. Fake TON Connect manifest claiming known project.
2. TON Shield flags manifest mismatch.
3. Transaction sends 97% balance.
4. TON Shield explains it in plain language.
5. Public report is shareable.
6. API response is one call.

### 25.2 Initial Distribution

- TON developer chats
- Telegram Mini App developer groups
- wallet teams
- security researchers
- GitHub issue replies for phishing reports
- TON Builders Portal
- X/Twitter threads with real examples
- short videos showing before/after signing clarity

### 25.3 Credibility Moves

- open-source the rule IDs and report schema
- publish a responsible disclosure policy
- publish false positive policy
- publish project verification process
- cite sources clearly
- avoid sensational claims

## 26. Risks And Mitigations

### 26.1 False Positives

Risk:

- good projects get flagged

Mitigation:

- explain all findings
- separate "unknown" from "malicious"
- allow appeals
- keep trusted registry reviewed
- provide raw evidence

### 26.2 False Negatives

Risk:

- user trusts TON Shield and gets drained

Mitigation:

- use careful language
- do not claim guarantees
- show uncertainty
- update rules frequently
- keep high-risk unknown warnings

### 26.3 Provider Dependence

Risk:

- TONAPI outage or rate limits break scans

Mitigation:

- cache aggressively
- add Toncenter fallback
- build direct SDK/get-method path
- return partial reports with provider status

### 26.4 Adversarial Evasion

Risk:

- scammers adapt manifests and transactions

Mitigation:

- focus on behavioral transaction analysis
- maintain intelligence feeds
- support user reports
- monitor clone patterns
- use multiple signals, not single rules

### 26.5 Legal/Reputation

Risk:

- calling something a scam can create disputes

Mitigation:

- distinguish "known malicious", "suspicious", "unknown"
- cite evidence
- provide appeal process
- avoid defamatory wording when uncertain

## 27. Future: Wallet V5 And Agent Wallet Guard

### 27.1 Wallet V5 Risks

Wallet V5 supports:

- gasless transactions
- account delegation and recovery
- subscription payments
- low-cost multi-transfers
- up to 255 messages
- extensions dictionary
- signature auth enable/disable flag

Security-relevant actions:

- add extension
- delete extension
- set signature auth allowed
- internal signed messages
- subscription/payment flows

TON Shield should eventually decode these actions and warn:

- "This request adds a wallet extension."
- "This request disables signature authentication."
- "This request removes an extension."
- "This request creates a recurring/subscription-like payment."

### 27.2 Agentic Wallet Risks

Agentic wallets:

- are self-custody wallets for autonomous AI agents
- use operator keys
- allow the agent to control funds inside the agent wallet
- can be revoked by owner
- were documented as not audited at time of research

Future product:

- agent wallet monitor
- policy engine
- spend limits
- allowlisted contracts
- blocked operations
- alerting
- revocation helper

Example policy:

```json
{
  "agent_wallet": "EQ...",
  "max_ton_per_day": "5",
  "allowed_jettons": ["USDT"],
  "allowed_recipients": ["EQ..."],
  "blocked_categories": ["unknown_contract", "nft_transfer"],
  "alert_channels": ["telegram"]
}
```

## 28. Open Questions

Product:

- Should public reports be indexed by search engines?
- Should users be able to scan privately?
- Should wallet integrations get stricter verdicts than consumer bot users?
- Should projects be able to claim official profiles?

Technical:

- Which TONAPI endpoints have stable rate limits for public launch?
- How reliable is emulation for Wallet V5 and gasless flows?
- Which provider gives best deploy-time and holder distribution data?
- How much Telegram metadata is available safely through Bot API versus MTProto?
- How should risk scoring handle missing wallet balance for unsigned requests?

Operational:

- Who moderates reports?
- What is the appeal SLA?
- How to avoid being used as a phishing link preview service?
- How to handle takedown requests?

## 29. Suggested Repository Structure

```text
tonshieldbot/
  apps/
    bot/
    api/
    web/
  packages/
    ton-parser/
    risk-engine/
    shared/
  docs/
    research/
      ton-shield-bot-implementation-spec.md
    api/
    operations/
  data/
    projects/
      known-projects.yaml
    rules/
      rules.yaml
  migrations/
  tests/
    fixtures/
```

If using a simpler first repo:

```text
tonshieldbot/
  src/
    bot/
    api/
    scanners/
    providers/
    rules/
    db/
  web/
  docs/
  data/
  tests/
```

## 30. Recommended MVP Stack

Backend:

- Node.js 24+
- TypeScript
- Fastify or Hono
- `@ton/core`
- `@ton/ton`
- `@ton-api/client`
- `grammy`
- Zod
- Drizzle or Prisma
- Postgres
- Redis/BullMQ or Faktory-like queue

Frontend:

- React
- Vite or Next.js
- Telegram Mini Apps SDK
- Tailwind or CSS modules

Infra:

- Docker Compose
- Caddy
- Postgres
- Redis
- Sentry
- OpenTelemetry later

Testing:

- Vitest
- fixtures
- golden report snapshots

## 31. First Engineering Milestone

Build this exact thin slice:

1. User sends TON Connect link to bot.
2. Bot parses `manifestUrl`.
3. API fetches manifest safely.
4. Risk engine checks origin mismatch and known-project impersonation.
5. API returns verdict and report ID.
6. Bot replies with concise warning.
7. Public report page shows details.

This slice proves the product without needing full transaction emulation.

Second slice:

1. User sends transaction JSON.
2. API parses messages.
3. API detects high-value transfer to unknown recipient.
4. API returns plain-language action preview.

Third slice:

1. User sends Jetton address.
2. API detects fake USDT-like metadata.
3. API explains trusted master mismatch.

## 32. Source Notes

Sources used during research:

- TON and Telegram exclusive partnership announcement, January 2025.
- Pavel Durov public Telegram posts around April/May 2026 on TON speed, fees, validator role, and dev tools. Note: the original `/493` reference appears to point to Login Widget in the public Telegram view; TON fee and validator/dev-tool posts appeared around later public post numbers.
- TON ecosystem support priorities: Payments, Simplified DeFi, GameFi, Telegram In-App Economy, AI.
- DeFiLlama chains API and stablecoins API for TON TVL and stablecoin supply.
- TON Connect overview, manifest docs, transaction docs, and request/response protocol.
- TONAPI accounts, traces, and emulation docs.
- TON Wallet V5 docs.
- TON agentic wallet docs.
- TON Jetton standard and Jetton payment processing docs.
- TON scam safety guide and safe app developer checklist.
- SlowMist analysis of origin forgery risk in TonConnect SDK.
- Neplox analysis of TON drainers.
- Kaspersky article on Telegram Mini App phishing.
- BleepingComputer/CTM360 reporting on Telegram Mini Apps abused for scams and malware delivery.
- `tonkeeper/ton-assets` public asset list.
- `ton-studio/ton-labels` public TON address labels.
- Telegram Bot API and Mini Apps docs.

## 33. Final Recommendation

Build TON Shield as a transaction and identity clarity product first, not as a broad security platform.

The first memorable product moment should be:

> Paste a TON Connect request. TON Shield tells you the app is impersonating Fragment and the transaction drains your wallet.

That is specific, demoable, useful, and aligned with the most visible risk in Telegram-native TON adoption.

