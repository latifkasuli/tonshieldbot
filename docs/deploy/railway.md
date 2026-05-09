# Deploying to Railway

TON Shield's first deploy target is [Railway](https://railway.app). This doc captures the one-time setup so deploys are reproducible from the repo and not from UI tribal knowledge.

## Services

| Railway service | Source         | Config-as-Code path      | Root directory |
| --------------- | -------------- | ------------------------ | -------------- |
| API             | `apps/api`     | `/apps/api/railway.toml` | repo root      |
| Bot             | `apps/bot`     | `/apps/bot/railway.toml` | repo root      |
| Postgres        | Railway plugin | _n/a_                    | _n/a_          |

The web app (`apps/web`) and worker (`apps/worker`) are not deployed yet — web is a placeholder landing page and worker is a stub.

**Important:** every service's _Root Directory_ stays at the repo root so the pnpm workspace install resolves all `workspace:*` deps. Each service then points at its own `railway.toml` via the _Config-as-Code Path_ setting.

## One-time setup

1. Create a Railway project.
2. Add a Postgres plugin to the project. Railway will inject `DATABASE_URL` into linked services.
3. Create the API service from this GitHub repo, branch `main`:
   - _Root Directory_: `/` (default)
   - _Config-as-Code Path_: `/apps/api/railway.toml`
   - Required env vars:
     - `API_HOST=0.0.0.0`
     - `DATABASE_URL` (linked from the Postgres plugin so reports persist and dedupe across requests)
     - (Railway injects `PORT` automatically; the API picks it up — no `API_PORT` needed)
   - Optional:
     - `REDIS_URL` (linked from a Railway Redis plugin if added — otherwise the api uses an in-process token bucket which only works for a single instance)
     - `NODE_ENV=production`
4. Create the Bot service from the same repo:
   - _Root Directory_: `/`
   - _Config-as-Code Path_: `/apps/bot/railway.toml`
   - Required env vars:
     - `BOT_TOKEN=<from BotFather>`
     - `DATABASE_URL` (so the bot's scan results land in the same store as the API's, sharing dedup)
   - Optional:
     - `REDIS_URL` (per-Telegram-user rate limit; in-process is fine for a single bot instance)
     - `NODE_ENV=production`
5. Apply database migrations once before deploying. From a local shell with `DATABASE_URL` pointed at the Railway Postgres:

   ```sh
   DATABASE_URL=<railway-postgres-url> pnpm --filter @tonshield/storage migrate:apply
   ```

6. Create at least one tenant + API key so partners can call `/v1/risk/scan`:

   ```sh
   DATABASE_URL=<railway-postgres-url> pnpm --filter @tonshield/storage bootstrap \
     --tenant internal --name bootstrap --scopes scan:write --tier internal
   ```

   Save the printed raw key immediately — only its hash is persisted.
   Run `pnpm --filter @tonshield/storage bootstrap --help` for all options.

## Build and start

Both services use Railway's default Railpack builder. Railpack reads `packageManager` and `engines.node` from the root `package.json` to pick pnpm 10.15.1 and Node 24. The default install phase runs `pnpm install --frozen-lockfile` at the repo root, so all workspace packages and devDependencies (including `tsx`) are available.

Start commands are explicit in each `railway.toml`:

- API: `pnpm --filter @tonshield/api start` → `tsx src/index.ts`
- Bot: `pnpm --filter @tonshield/bot start` → `tsx src/index.ts`

Running TypeScript directly with `tsx` is acceptable for this stage. A future hardening PR will add a build step that emits `.js` and starts with plain `node` for faster cold start and a slimmer image.

## Healthchecks

- **API**: `GET /health` returns `{ ok: true, service: "tonshield-api" }`. Configured in `apps/api/railway.toml` with a 30s timeout.
- **Bot**: long-polling, no HTTP server. Railway falls back to process liveness as the health signal. No healthcheck path needed.

## Updating env vars

Use Railway's UI or CLI; do not commit env values to the repo. The repo only contains the _shape_ of the config (`railway.toml`), never secrets.

## Migrations on deploy

Migrations are not run automatically on service startup — that's risky in a multi-instance deployment and surprises operators. Apply them manually with the command above, or wire a Railway "Job" service that runs `pnpm --filter @tonshield/storage migrate:apply` once before promoting a release.

## Troubleshooting

- **Build fails with "no lockfile"**: confirm _Root Directory_ is `/`, not `apps/api`. Railpack needs the repo-root `pnpm-lock.yaml` for `--frozen-lockfile`.
- **API starts but Railway shows the service as unhealthy**: confirm the service is listening on `0.0.0.0` (not `127.0.0.1`) and that `PORT` is being honored. The current `loadApiConfig` reads `API_PORT > PORT > 3000`.
- **Bot crashes on startup with `BOT_TOKEN` missing**: the bot validates env via zod at startup; check the Railway service env vars.
- **`tsx` not found at runtime**: Railway should install devDependencies for this first staging setup. If that changes, move `tsx` from devDependencies to dependencies or ship the compiled-JS start path.
