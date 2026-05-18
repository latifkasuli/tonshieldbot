# Deploying to Railway

TON Shield's first deploy target is [Railway](https://railway.app). This doc captures the one-time setup so deploys are reproducible from the repo and not from UI tribal knowledge.

## Services

| Railway service | Source         | Config-as-Code path         | Root directory |
| --------------- | -------------- | --------------------------- | -------------- |
| API             | `apps/api`     | `/apps/api/railway.toml`    | repo root      |
| Bot             | `apps/bot`     | `/apps/bot/railway.toml`    | repo root      |
| Worker          | `apps/worker`  | `/apps/worker/railway.toml` | repo root      |
| Postgres        | Railway plugin | _n/a_                       | _n/a_          |

The web app (`apps/web`) is not deployed yet — it's still a placeholder landing page.

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
5. Create the Worker service from the same repo:
   - _Root Directory_: `/`
   - _Config-as-Code Path_: `/apps/worker/railway.toml`
   - Required env vars:
     - `DATABASE_URL` (linked from the Postgres plugin — must point at the same DB as the API/bot, since the worker writes the gift catalog the API reads)
     - `TELEGRAM_INTEL_BOT_TOKEN` (same value as the API's; without it the worker logs `gift_catalog_refresh_skipped_disabled` and never populates the catalog)
   - Optional:
     - `GIFT_CATALOG_REFRESH_INTERVAL_MS` (default `3600000` = 1h; min 60s, max 24h)
     - `SNAPSHOT_RETENTION_DAYS` (default `365`; min 1, max 3650 — per design doc decision #9, public-entity snapshots retained for one year)
     - `SNAPSHOT_RETENTION_INTERVAL_MS` (default `86400000` = 24h; min 60s, max 7d)
     - `SNAPSHOT_RETENTION_MAX_ROWS_PER_RUN` (default `100000`; min 1, max 1000000 — bounds delete blast radius if retention is misconfigured)
     - `TELEGRAM_API_BASE_URL` (override only when self-hosting a local Bot API server)
     - `NODE_ENV=production`
   - Not used by the worker: `REDIS_URL`, `PORT` — the worker runs periodic `setInterval`-driven jobs and exposes no HTTP surface.
6. Database migrations run automatically before each API, Bot, and Worker deployment via each service's Railway `preDeployCommand`:

   ```sh
   pnpm --filter @tonshield/storage migrate:apply
   ```

   The migration runner uses a Postgres advisory lock, so it is safe if multiple Railway services deploy at the same time. Only one service applies migrations; the others wait until the lock is released and then observe the database as already up to date.

   You can still run the same command manually from a local shell when needed:

   ```sh
   DATABASE_URL=<railway-postgres-url> pnpm --filter @tonshield/storage migrate:apply
   ```

7. Create at least one tenant + API key so partners can call `/v1/risk/scan`:

   ```sh
   DATABASE_URL=<railway-postgres-url> pnpm --filter @tonshield/storage bootstrap \
     --tenant internal --name bootstrap --scopes scan:write --tier internal
   ```

   Save the printed raw key immediately — only its hash is persisted.
   Run `pnpm --filter @tonshield/storage bootstrap --help` for all options.

## Build and start

All Node services use Railway's default Railpack builder. Railpack reads `packageManager` and `engines.node` from the root `package.json` to pick pnpm 10.15.1 and Node 24. The default install phase runs `pnpm install --frozen-lockfile` at the repo root, so all workspace packages and devDependencies (including `esbuild` and `tsx`) are available.

Each service's `railway.toml` declares an explicit `buildCommand` and `startCommand`:

- API: build → `pnpm --filter @tonshield/api build`, start → `pnpm --filter @tonshield/api start` (`node --enable-source-maps dist/index.js`)
- Bot: build → `pnpm --filter @tonshield/bot build`, start → `pnpm --filter @tonshield/bot start`
- Worker: build → `pnpm --filter @tonshield/worker build`, start → `pnpm --filter @tonshield/worker start`

The build step invokes a small esbuild script ([scripts/build-app.mjs](../../scripts/build-app.mjs)) that produces a single self-contained ESM bundle at `apps/<app>/dist/index.js` plus a sourcemap. `@tonshield/*` workspace source is inlined into the bundle; npm runtime deps are also bundled (so the production container doesn't need to resolve pnpm symlinks under `apps/<app>/node_modules`), with a `createRequire` banner so CJS packages like `pino` and `drizzle-orm` work inside the ESM output.

The runtime container runs plain `node` against the bundle — no `tsx` in the hot path. `tsx` stays in devDependencies for `pnpm dev` and for the migration script (`pnpm --filter @tonshield/storage migrate:apply`).

## Healthchecks

- **API**: `GET /health` returns `{ ok: true, service: "tonshield-api" }`. Configured in `apps/api/railway.toml` with a 30s timeout.
- **Bot**: long-polling, no HTTP server. Railway falls back to process liveness as the health signal. No healthcheck path needed.
- **Worker**: no HTTP server, same liveness-only posture as the bot. Logs are the operational signal — search Railway's log viewer for `gift_catalog_refreshed` (success) or `gift_catalog_refresh_failed` (degraded). Snapshot retention emits `snapshot_retention_run` with `deleted_count` + `capped` (true when the per-run cap was hit and the next tick will pick up the rest).

## Updating env vars

Use Railway's UI or CLI; do not commit env values to the repo. The repo only contains the _shape_ of the config (`railway.toml`), never secrets.

## Migrations on deploy

Migrations are run automatically by Railway before each service starts using `preDeployCommand`. This happens in a separate one-off container between build and deploy; if migrations fail, Railway does not promote that deployment.

Because API, Bot, and Worker can deploy concurrently from the same repo, the migration command is not raw `drizzle-kit migrate`. It is `packages/storage/scripts/migrate.ts`, which wraps Drizzle's migrator with a Postgres advisory lock. This avoids duplicate/concurrent migration attempts while keeping each service independently deployable.

Operational notes:

- Keep migrations backwards-compatible with the currently running app version. Railway may still have the old deployment serving while a new one builds.
- Additive migrations are safe for the current stage. For destructive changes, use expand/migrate/contract: add new schema first, deploy app compatibility, backfill, then remove old schema in a later release.
- `MIGRATION_LOCK_TIMEOUT_MS` can override the default 5-minute lock wait if a migration ever needs longer.

## Troubleshooting

- **Build fails with "no lockfile"**: confirm _Root Directory_ is `/`, not `apps/api`. Railpack needs the repo-root `pnpm-lock.yaml` for `--frozen-lockfile`.
- **Build fails with `Cannot find module '@esbuild/<platform>'`**: pnpm 10 skips esbuild's postinstall by default; the root `package.json` allows it via `pnpm.onlyBuiltDependencies`. If you forked the workspace and rewrote that field, re-add esbuild there.
- **`dist/index.js` not found at start**: the build step didn't run, or it ran in a different image than start. Verify the service's `buildCommand` in Railway matches the value in `railway.toml`.
- **API starts but Railway shows the service as unhealthy**: confirm the service is listening on `0.0.0.0` (not `127.0.0.1`) and that `PORT` is being honored. The current `loadApiConfig` reads `API_PORT > PORT > 3000`.
- **Bot crashes on startup with `BOT_TOKEN` missing**: the bot validates env via zod at startup; check the Railway service env vars.
