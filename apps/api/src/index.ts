import { serve } from "@hono/node-server";
import { loadApiConfig } from "./env.ts";
import { createApiServer } from "./server.ts";

const config = loadApiConfig();
const app = createApiServer();

serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    console.log(`TON Shield API listening on http://${info.address}:${String(info.port)}`);
  },
);
