import { serve } from "@hono/node-server";
import { createApiDependencies } from "./deps.ts";
import { loadApiConfig } from "./env.ts";
import { createApiServer } from "./server.ts";

const config = loadApiConfig();
const deps = createApiDependencies(config);
const app = createApiServer({
  logger: deps.logger,
  apiKeys: deps.storage.apiKeys,
  reports: deps.storage.reports,
  rateLimiter: deps.rateLimiter,
  emulator: deps.emulator,
  telegramIntel: deps.telegramIntel,
  mtprotoIntel: deps.mtprotoIntel,
  telegramEntities: deps.storage.telegramEntities,
  telegramGiftCatalog: deps.storage.telegramGiftCatalog,
  fragment: deps.fragment,
  fragmentCache: deps.fragmentCache,
});

serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    deps.logger.info({ host: info.address, port: info.port }, "api_listening");
  },
);

const shutdown = async (signal: string): Promise<void> => {
  deps.logger.info({ signal }, "api_shutting_down");
  await deps.close();
  process.exit(0);
};

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
