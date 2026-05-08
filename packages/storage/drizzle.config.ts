import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration. Used only at migration generation/apply time:
 *
 *   pnpm --filter @tonshield/storage migrate:generate -- --name=...
 *   pnpm --filter @tonshield/storage migrate:apply
 *
 * Application code never imports from this file; the runtime client lives
 * in `src/postgres/client.ts`.
 *
 * `DATABASE_URL` is required when running `migrate:apply`. For
 * `migrate:generate` the URL is unused — generation is a static diff
 * against `src/postgres/schema.ts`.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/postgres/schema.ts",
  out: "./migrations",
  // Falls back to a placeholder so `migrate:generate` works without env.
  // `migrate:apply` will override via the actual environment.
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://placeholder/placeholder",
  },
  strict: true,
  verbose: true,
});
