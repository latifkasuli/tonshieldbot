import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

export type StorageDb = NodePgDatabase<typeof schema>;

export interface PostgresClient {
  readonly db: StorageDb;
  readonly close: () => Promise<void>;
}

export interface PostgresClientConfig {
  readonly databaseUrl: string;
  /** Override the pool max — defaults to a conservative 10. */
  readonly poolMax?: number;
}

/**
 * Builds a Postgres client backed by `pg.Pool`. Callers own the lifecycle:
 * call `close()` on shutdown to drain the pool.
 */
export const createPostgresClient = (config: PostgresClientConfig): PostgresClient => {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.poolMax ?? 10,
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    close: async () => {
      await pool.end();
    },
  };
};
