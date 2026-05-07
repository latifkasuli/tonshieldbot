# TON Shield Bot

Telegram-native risk checks for TON Connect requests, Mini Apps, Jettons, addresses, and transaction payloads.

## Stack

- TypeScript across API, bot, scanner packages, worker, and web UI
- Node.js 24 LTS
- Strict compiler configuration with `strict`, `noImplicitAny`, `strictNullChecks`, and `noUncheckedIndexedAccess`
- `@ton/core`, `@ton/ton`, and `@ton-api/client` for TON integration
- `grammy` for Telegram bot handling
- Hono for the HTTP API
- React + Vite for the Mini App/public report UI

## Commands

```sh
nvm use
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm check
```

## Development

```sh
pnpm dev:api
pnpm dev:bot
pnpm dev:web
```

The bot requires `BOT_TOKEN` in the environment.
