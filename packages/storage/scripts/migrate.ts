import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../src/postgres/schema.ts";

/**
 * Railway may deploy API, bot, and worker services at the same time. Drizzle's
 * migrator is intentionally small and does not serialize concurrent callers,
 * so this script wraps it in a Postgres advisory lock before applying any
 * migrations. That makes it safe to use as each service's preDeployCommand.
 */

const MIGRATION_LOCK_KEY_1 = 1_415_417_171;
const MIGRATION_LOCK_KEY_2 = 1_292_893_014;
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const LOCK_POLL_MS = 1_000;

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  console.error("ERROR: DATABASE_URL is required to apply migrations.");
  process.exit(1);
}

const lockTimeoutMs = parseLockTimeout(process.env.MIGRATION_LOCK_TIMEOUT_MS);
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 2,
});

const lockClient = await pool.connect();
let lockAcquired = false;

try {
  lockAcquired = await acquireMigrationLock(lockClient, lockTimeoutMs);
  const db = drizzle(pool, { schema });

  console.info("Applying database migrations...");
  await migrate(db, { migrationsFolder });
  console.info("Database migrations are up to date.");
} finally {
  if (lockAcquired) {
    await lockClient.query("SELECT pg_advisory_unlock($1, $2)", [
      MIGRATION_LOCK_KEY_1,
      MIGRATION_LOCK_KEY_2,
    ]);
  }
  lockClient.release();
  await pool.end();
}

async function acquireMigrationLock(client: pg.PoolClient, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();

  for (;;) {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [MIGRATION_LOCK_KEY_1, MIGRATION_LOCK_KEY_2],
    );

    if (result.rows[0]?.locked === true) {
      console.info("Acquired database migration lock.");
      return true;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for database migration lock after ${String(timeoutMs)}ms`);
    }

    console.info("Waiting for another deployment to finish database migrations...");
    await sleep(LOCK_POLL_MS);
  }
}

function parseLockTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_LOCK_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_000) {
    throw new Error("MIGRATION_LOCK_TIMEOUT_MS must be an integer >= 1000.");
  }

  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
