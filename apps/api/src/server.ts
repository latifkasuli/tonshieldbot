import { Hono } from "hono";
import { z } from "zod";
import { createHonoLogger } from "@tonshield/logger";
import type { Logger, LoggerVariables } from "@tonshield/logger";
import { TtlFetchCache } from "@tonshield/safe-fetch";
import { createBasicScan } from "@tonshield/ton-scanner";

const scanRequestSchema = z.object({
  input: z.string().min(1),
});

export interface CreateApiServerOptions {
  readonly logger: Logger;
}

export const createApiServer = (
  options: CreateApiServerOptions,
): Hono<{ Variables: LoggerVariables }> => {
  const app = new Hono<{ Variables: LoggerVariables }>();
  const manifestCache = new TtlFetchCache();

  app.use("*", createHonoLogger({ logger: options.logger }));

  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "tonshield-api",
    }),
  );

  app.post("/v1/risk/scan", async (context) => {
    const body = scanRequestSchema.safeParse(await context.req.json());

    if (!body.success) {
      return context.json(
        {
          error: "invalid_request",
          issues: body.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        400,
      );
    }

    const report = await createBasicScan({
      cache: manifestCache,
      rawInput: body.data.input,
    });

    return context.json(report);
  });

  return app;
};
