# TON Shield — Privacy Policy

Last updated: 2026-05-10
Status: Draft — to be published at `/privacy` on the public API in M3 PR-1.

This policy describes what TON Shield collects, what it does with that data, and how to make us delete it. It is grounded in [Telegram's Bot Developer Terms of Service](https://telegram.org/tos/bot-developers) (§§4.1–4.3) and applies to anyone who interacts with the TON Shield Telegram bot, the public scan API, or any TON Shield Mini App.

## 1. Who we are

TON Shield is a Telegram-native security scanner for the TON ecosystem. The service is operated by the `latifkasuli/tonshieldbot` project. Source code is at <https://github.com/latifkasuli/tonshieldbot>. Contact: see the repository's README.

## 2. What we collect

### 2.1 From your messages to our bot

When you forward, paste, or send a message, link, or Mini App URL to our scanner bot, we read:

- The text of your message (so we can parse what to scan).
- Any deep link, URL, TON address, transaction JSON, or BOC inside the message.
- Metadata of forwarded messages: the original sender (user, channel, or hidden user), the original send timestamp, the original chat identifier, the inline buttons attached. This is the standard `forward_origin` data the Telegram Bot API exposes.
- Your own Telegram user ID, username, first/last name, and language code (Telegram includes these in every update).

### 2.2 About public Telegram entities you ask us to scan

When you submit a public channel, supergroup, bot, or Mini App for scanning, we may call the Telegram Bot API to enrich the scan:

- `getChat` on public channel/supergroup handles to read title, description, photo, member count, accepted gift types, active usernames, and similar public profile fields.
- `getAvailableGifts` to maintain our reference catalogue of legitimate Telegram gift designs.
- `getUserGifts` or `getChatGifts` to list publicly displayed owned gifts (only the ones the entity has chosen to display on its profile, unless we are an administrator of that channel — which we are not).

We do not enter private chats, private channels, or any chat in which our bot is not an explicit member.

### 2.3 About TON blockchain addresses you ask us to scan

For TON addresses, TON Connect manifests, signed BOCs, and transaction-JSON inputs, we call TONAPI to read public on-chain data and emulate the proposed action. This is read-only.

### 2.4 What we never collect

- We never read private DMs between you and any third party.
- We never read messages in chats our bot is not a member of.
- We never collect, derive, or store private keys, seed phrases, or wallet recovery data — and we will refuse to operate if you attempt to share them.
- We never sell or share your data with third parties for advertising or profiling.

## 3. What we do with it

- Run the scan you asked for and return a risk report.
- Persist scan reports keyed by a hash of the canonical input, so a later identical scan can return the same report without re-doing the work. Reports include the input you submitted (e.g. the link or transaction body) and the findings we produced.
- Maintain snapshots of public Telegram-entity metadata (handle, display name, bio, member count, photo identifier) over time, so we can detect username churn, recent renames, and impersonation patterns. Snapshots are keyed by the entity's stable numeric Telegram ID. No private-DM content is stored.
- Maintain a watchlist of legitimate project handles for impersonation detection. This watchlist is seeded from publicly-published vendor warning pages (e.g. Binance, Coinbase, Tonkeeper) on a low-frequency cron.
- Cross-reference media file identifiers (`file_unique_id`) across submissions to detect scam-asset reuse. We do not download or store the media files themselves.

## 4. How long we keep it

- **Public-entity snapshots**: 365 days, rolling.
- **Raw submitted message text**: 30 days.
- **Scan reports**: indefinite (they are the product). You can request deletion via §6 below.
- **Media file identifiers (`file_unique_id`) and perceptual hashes**: indefinite, retained for cross-channel de-duplication. These do NOT identify you, only the media file.
- **Rate-limit counters**: at most 24 hours.

## 5. Where the data lives

- Postgres database on Railway (US region).
- Redis on Railway, used for rate limiting and short-lived caches.
- Server logs on Railway, retained for 7 days.

We do not transfer your data outside these systems except as required by §7.

## 6. Your rights

You can ask us to delete any data we hold about you by sending `/forgetme` to our scanner bot. This will:

- Delete every scan you have ever submitted, along with the rate-limit counters tied to your Telegram user ID.
- Delete server logs that include your Telegram user ID (best-effort within the 7-day log retention window).

Public-entity snapshots are not user-specific and are retained per §4. If a snapshot contains information about _you specifically_ (e.g. you operate a public channel and want it removed), email the contact in the repository's README and we will action it within 30 days.

## 7. When we share data

- **Lawful requests**: we comply with valid legal process. We will notify you if we receive a request that targets you, unless prohibited by law.
- **No commercial sharing**: we do not sell, license, or share your data with third parties for advertising, profiling, or any other commercial purpose.

## 8. Security

- The Bot API token, TONAPI key, and database credentials are stored as Railway environment secrets, never in source control.
- TLS is enforced between TON Shield services and Telegram / TONAPI.
- We treat all user-submitted content as untrusted input and pass it through fail-soft validation before any external fetch.

## 9. Changes to this policy

We will update this document and the `/privacy` endpoint when material changes are made. The `Last updated` date at the top reflects the most recent revision.

## 10. Contact

Issues and concerns: open a GitHub issue at <https://github.com/latifkasuli/tonshieldbot/issues>, or use the contact email in the repository README.
