#!/usr/bin/env node
/**
 * Shared build entry for the production app bundles. Each app's
 * `pnpm build` script invokes this with its own directory.
 *
 * What this produces:
 *   <app>/dist/index.js     — single ESM bundle, Node-targeted
 *   <app>/dist/index.js.map — sourcemap for prod stacktraces
 *
 * Bundling policy:
 *   - `@tonshield/*` workspace packages are inlined into the bundle.
 *     Their source is small, they share no runtime state, and inlining
 *     means the production container doesn't need pnpm to resolve
 *     workspace symlinks. Build once, ship one file per app.
 *   - Everything else (hono, grammy, drizzle-orm, ioredis, pg, …) stays
 *     external. These have native bindings, dynamic requires, or just
 *     don't tree-shake well; bundling them is asking for trouble.
 *
 * Why esbuild rather than tsc per-package emit:
 *   The project's existing tsconfig is bundler-mode with
 *   `allowImportingTsExtensions` + `noEmit`. Switching to per-package
 *   tsc emit would require touching every package's `exports` field,
 *   every tsconfig, and the workspace's import resolution. esbuild
 *   takes the tsconfig as input and produces one self-contained
 *   bundle — much smaller blast radius for the same operational win
 *   (no tsx at runtime, faster cold start, slimmer image).
 */

import { build } from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const appDirArg = process.argv[2];
if (appDirArg === undefined || appDirArg.length === 0) {
  console.error("usage: build-app.mjs <appDir>");
  process.exit(1);
}

// Caller passes paths relative to its own cwd; resolve absolute so the
// script behaves the same whether invoked from the workspace root or
// the app directory.
const appDir = resolve(process.cwd(), appDirArg);
const pkgJsonPath = resolve(appDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));

const entry = resolve(appDir, "src/index.ts");
const outfile = resolve(appDir, "dist/index.js");

mkdirSync(dirname(outfile), { recursive: true });

/**
 * The bundle includes everything that isn't a Node built-in:
 * `@tonshield/*` workspace source plus all transitive npm runtime deps
 * (pino, drizzle-orm, grammy, pg, …). Yes, this makes the bundle ~4 MB;
 * that's fine for backend services and avoids the alternative pain of
 * declaring every transitive dep as a direct app dep so pnpm symlinks
 * them under `apps/<app>/node_modules`.
 *
 * The `createRequire` banner is the standard fix for CJS packages
 * (pino, drizzle-orm, etc.) inlined into an ESM bundle: their internal
 * `require("node:os")` and friends need a real `require` at runtime,
 * which esbuild's auto-shim doesn't supply for the `node:` scheme.
 */
const createRequireBanner = [
  `import { createRequire as ___createRequire } from "node:module";`,
  `const require = ___createRequire(import.meta.url);`,
].join("\n");

const startedAt = Date.now();

await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile,
  sourcemap: true,
  resolveExtensions: [".ts", ".js", ".mjs", ".json"],
  minify: false,
  loader: { ".json": "json" },
  banner: { js: createRequireBanner },
  logLevel: "info",
});

const sizeKb = Math.round(Buffer.byteLength(readFileSync(outfile, "utf8"), "utf8") / 1024);
const durationMs = Date.now() - startedAt;

console.log(`built ${pkg.name} → ${outfile} (${String(sizeKb)} KB, ${String(durationMs)} ms)`);
