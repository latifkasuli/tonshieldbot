import { lookup } from "node:dns/promises";
import { Agent, buildConnector, request as undiciRequest } from "undici";
import { err, ok } from "@tonshield/shared";
import { BlockedIpError, validateIp } from "./ip-validator.ts";
import type { SafeFetchOptions, SafeFetchResult, SafeFetchSuccess } from "./types.ts";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const createSsrfSafeConnector = (): buildConnector.connector => {
  const defaultConnector = buildConnector({});

  return (options, callback) => {
    lookup(options.hostname, { family: 0 })
      .then(({ address, family }) => {
        validateIp(address, family as 4 | 6);
        defaultConnector(
          {
            ...options,
            hostname: address,
            servername: options.servername ?? options.hostname,
          },
          callback,
        );
      })
      .catch((error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), null);
      });
  };
};

const agent = new Agent({
  connect: createSsrfSafeConnector(),
  connections: 2,
});

const inFlight = new Map<string, Promise<SafeFetchResult>>();

interface BodyStream {
  destroy(): void;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

const consumeBody = async (body: BodyStream): Promise<void> => {
  for await (const chunk of body) {
    void chunk;
    // Discard response bodies on redirects and failed status codes so sockets can close cleanly.
  }
};

const chunkToBuffer = (chunk: unknown): Buffer => {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (typeof chunk === "string") {
    return Buffer.from(chunk, "utf8");
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }

  return Buffer.from(String(chunk), "utf8");
};

const doFetch = async (
  url: URL,
  signal: AbortSignal,
  maxBytes: number,
  maxRedirects: number,
  hopCount = 0,
): Promise<SafeFetchResult> => {
  if (url.protocol !== "https:") {
    return err("https_required");
  }

  if (hopCount > maxRedirects) {
    return err("too_many_redirects");
  }

  let response: Awaited<ReturnType<typeof undiciRequest>>;

  try {
    response = await undiciRequest(url.toString(), {
      dispatcher: agent,
      headers: {
        accept: "application/json, */*+json",
        "user-agent": "TONShield/0.1 manifest-scanner",
      },
      signal,
    });
  } catch (error: unknown) {
    return mapFetchError(error);
  }

  if (REDIRECT_STATUSES.has(response.statusCode)) {
    await consumeBody(response.body);

    const locationHeader = response.headers.location;
    const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;

    if (location === undefined) {
      return err("fetch_failed");
    }

    try {
      return await doFetch(new URL(location, url), signal, maxBytes, maxRedirects, hopCount + 1);
    } catch {
      return err("fetch_failed");
    }
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    await consumeBody(response.body);
    return err("fetch_failed");
  }

  const rawContentType = response.headers["content-type"];
  const contentType = Array.isArray(rawContentType)
    ? (rawContentType[0] ?? null)
    : (rawContentType ?? null);

  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  for await (const chunk of response.body) {
    const buffer = chunkToBuffer(chunk);
    receivedBytes += buffer.byteLength;

    if (receivedBytes > maxBytes) {
      response.body.destroy();
      return err("response_too_large");
    }

    chunks.push(buffer);
  }

  return ok({
    body: Buffer.concat(chunks, receivedBytes).toString("utf8"),
    contentType,
    finalUrl: url,
  } satisfies SafeFetchSuccess);
};

const mapFetchError = (error: unknown): SafeFetchResult => {
  if (error instanceof BlockedIpError) {
    return err("ssrf_blocked");
  }

  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.toLowerCase().includes("abort"))
  ) {
    return err("fetch_timeout");
  }

  return err("fetch_failed");
};

export const safeFetch = (url: URL, options: SafeFetchOptions = {}): Promise<SafeFetchResult> => {
  const { cache, maxBytes = 100_000, maxRedirects = 3, timeoutMs = 5_000 } = options;
  const cacheKey = url.toString();
  const cached = cache?.get(cacheKey);

  if (cached !== undefined) {
    return Promise.resolve(ok(cached.success));
  }

  const existing = inFlight.get(cacheKey);

  if (existing !== undefined) {
    return existing;
  }

  const fetchPromise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const result = await doFetch(url, controller.signal, maxBytes, maxRedirects);

      if (result.ok && cache !== undefined) {
        cache.set(cacheKey, { cachedAt: Date.now(), success: result.value });
      }

      return result;
    } finally {
      clearTimeout(timeout);
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, fetchPromise);
  return fetchPromise;
};
