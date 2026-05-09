/**
 * One-shot bootstrap: create a tenant + an API key in the configured database.
 *
 * Required env:
 *   DATABASE_URL   Postgres connection string. Without this the script aborts
 *                  rather than silently writing to an in-memory store.
 *
 * Optional flags:
 *   --tenant <name>   default: "internal"
 *   --name <name>     default: "bootstrap"   (human label for the key)
 *   --scopes <list>   default: "scan:write"  (comma-separated)
 *   --tier <tier>     default: "internal"
 *
 * Example:
 *   DATABASE_URL=postgres://... \
 *     pnpm --filter @tonshield/storage bootstrap \
 *     --tenant acme --name prod --scopes scan:write --tier partner
 *
 * The raw key is printed once and never persisted. Save it immediately.
 */
import { parseArgs } from "node:util";
import {
  apiKeyScopes,
  createStorage,
  rateLimitTiers,
  type ApiKeyScope,
  type RateLimitTier,
} from "../src/index.ts";

const HELP_TEXT = `
Create a tenant and API key in the configured Postgres database.

Usage:
  DATABASE_URL=postgres://... pnpm --filter @tonshield/storage bootstrap [options]

Options:
  --tenant <name>   Tenant name. Default: internal
  --name <name>     Human label for the key. Default: bootstrap
  --scopes <list>   Comma-separated scopes. Default: scan:write
                    Allowed: ${apiKeyScopes.join(", ")}
  --tier <tier>     Rate-limit tier. Default: internal
                    Allowed: ${rateLimitTiers.join(", ")}
  -h, --help        Show this help message.

Example:
  DATABASE_URL=postgres://... pnpm --filter @tonshield/storage bootstrap \\
    --tenant acme --name prod --scopes scan:write --tier partner

The raw key is printed once and never persisted. Save it immediately.
`.trim();

// parseArgs with `default` guarantees these are strings, never undefined.
const { values } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    tenant: { type: "string", default: "internal" },
    name: { type: "string", default: "bootstrap" },
    scopes: { type: "string", default: "scan:write" },
    tier: { type: "string", default: "internal" },
  },
});

if (values.help === true) {
  console.log(HELP_TEXT);
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.length === 0) {
  console.error("ERROR: DATABASE_URL is required.");
  console.error("Set it to your Postgres connection string and re-run.");
  console.error("");
  console.error("Run with --help to see usage.");
  process.exit(1);
}

const tenantName = values.tenant;
const keyName = values.name;
const requestedScopes = values.scopes
  .split(",")
  .map((scope) => scope.trim())
  .filter((scope) => scope.length > 0);
const requestedTier = values.tier;

const isApiKeyScope = (value: string): value is ApiKeyScope =>
  (apiKeyScopes as readonly string[]).includes(value);
const isRateLimitTier = (value: string): value is RateLimitTier =>
  (rateLimitTiers as readonly string[]).includes(value);

const invalidScopes = requestedScopes.filter((scope) => !isApiKeyScope(scope));

if (invalidScopes.length > 0) {
  console.error(`ERROR: unknown scope(s): ${invalidScopes.join(", ")}`);
  console.error(`Allowed: ${apiKeyScopes.join(", ")}`);
  process.exit(1);
}

if (!isRateLimitTier(requestedTier)) {
  console.error(`ERROR: unknown tier: ${requestedTier}`);
  console.error(`Allowed: ${rateLimitTiers.join(", ")}`);
  process.exit(1);
}

const scopes: readonly ApiKeyScope[] = requestedScopes.filter(isApiKeyScope);
const tier: RateLimitTier = requestedTier;

const storage = createStorage({ databaseUrl });

try {
  const tenant = await storage.tenants.create({ name: tenantName });
  const created = await storage.apiKeys.create({
    tenantId: tenant.id,
    name: keyName,
    scopes,
    rateLimitTier: tier,
  });

  console.log("");
  console.log(`Tenant created: ${tenant.id} (${tenant.name})`);
  console.log(`API key created: ${created.metadata.id} (${created.metadata.name})`);
  console.log(`  scopes: ${created.metadata.scopes.join(", ")}`);
  console.log(`  tier:   ${created.metadata.rateLimitTier}`);
  console.log("");
  console.log("================================================================");
  console.log("RAW API KEY (shown once — save it now, only its hash is stored):");
  console.log("");
  console.log(`  ${created.rawKey}`);
  console.log("");
  console.log("================================================================");
  console.log("");
  console.log("Test the key against your deployed API:");
  console.log("");
  console.log("  curl -X POST https://api.tonshield.io/v1/risk/scan \\");
  console.log(`    -H "Authorization: Bearer ${created.rawKey}" \\`);
  console.log('    -H "Content-Type: application/json" \\');
  console.log('    -d \'{"input":"https://app.tonkeeper.com/tonconnect-manifest.json"}\'');
  console.log("");
} finally {
  await storage.close();
}
