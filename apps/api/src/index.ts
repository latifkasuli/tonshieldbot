import { serve } from "@hono/node-server";
import { createLogger } from "@tonshield/logger";
import { loadApiConfig } from "./env.ts";
import { createApiServer } from "./server.ts";

const logger = createLogger({ service: "tonshield-api" });
const config = loadApiConfig();
const app = createApiServer({ logger });

serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    logger.info({ host: info.address, port: info.port }, "api_listening");
  },
);
