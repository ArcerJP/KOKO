import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { createImageDatabase } from "./db.js";
import { createImageR2Store, type ImageR2Env } from "./r2.js";
import { createImageRunner } from "./runner.js";
import { createGoogleCallerVerifier } from "./service-auth.js";
import { createImageService } from "./service.js";

export type ImageServiceEnv = ImageR2Env & {
  KOKO_IMAGE_SERVICE_ENABLED?: string;
  KOKO_IMAGE_SERVICE_AUDIENCE?: string;
  KOKO_IMAGE_CALLER_EMAIL?: string;
  KOKO_IMAGE_CALLER_SUBJECT?: string;
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
};

/** Explicit configuration only. Does not create IAM resources or read env on import. */
export function configuredImageService(env: ImageServiceEnv) {
  if (env.KOKO_IMAGE_SERVICE_ENABLED !== "true") return createImageService();
  const authenticate = createGoogleCallerVerifier({
    audience: env.KOKO_IMAGE_SERVICE_AUDIENCE ?? "",
    callerEmail: env.KOKO_IMAGE_CALLER_EMAIL ?? "",
    callerSubject: env.KOKO_IMAGE_CALLER_SUBJECT ?? "",
  });
  const database = createImageDatabase({
    enabled: true,
    supabaseUrl: env.SUPABASE_URL ?? "",
    secretKey: env.SUPABASE_SECRET_KEY ?? "",
  });
  const store = createImageR2Store(env);
  const runner = createImageRunner({ enabled: true, database, store })!;
  return createImageService({ enabled: true, authenticate, run: runner.run });
}

/** Transport adapter; caller chooses loopback for local tests, 0.0.0.0 for Cloud Run. */
export function createImageHttpServer(
  handle: (request: Request) => Promise<Response>,
): Server {
  const server = createServer(
    { maxHeaderSize: 16384, headersTimeout: 5000, requestTimeout: 10000 },
    async (incoming, outgoing) => {
      // Every call is bounded and independent. Close early-rejected uploads after
      // flushing the fixed response instead of draining an attacker-controlled body.
      outgoing.setHeader("connection", "close");
      outgoing.once("finish", () => {
        if (!incoming.complete) incoming.destroy();
      });
      const abort = new AbortController();
      incoming.once("aborted", () => abort.abort());
      outgoing.once("close", () => {
        if (!outgoing.writableEnded) abort.abort();
      });
      try {
        // Reject ambiguous duplicate headers before Node normalizes/discards them.
        const seen = new Set<string>();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          const name = incoming.rawHeaders[i]!.toLowerCase();
          if (
            [
              "authorization",
              "content-type",
              "content-length",
              "content-encoding",
            ].includes(name)
          ) {
            if (seen.has(name)) throw new Error("INVALID_REQUEST");
            seen.add(name);
          }
        }
        const path = incoming.url;
        if (path !== "/health" && path !== "/internal/image")
          throw new Error("INVALID_REQUEST");
        if (Number(incoming.headers["content-length"] ?? "0") > 1024)
          throw new Error("INVALID_REQUEST");
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined && name !== "host")
            headers.set(name, Array.isArray(value) ? value.join(",") : value);
        }
        const init: RequestInit & { duplex?: "half" } = {
          method: incoming.method ?? "GET",
          headers,
          signal: abort.signal,
        };
        if (init.method !== "GET" && init.method !== "HEAD") {
          init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
          init.duplex = "half";
        }
        const response = await handle(
          new Request(`http://image.internal${path}`, init),
        );
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          responseHeaders[name] = value;
        });
        outgoing.writeHead(response.status, responseHeaders);
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        if (!outgoing.headersSent)
          outgoing.writeHead(400, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
        outgoing.end('{"error":{"code":"INVALID_REQUEST"}}');
      }
    },
  );
  server.maxRequestsPerSocket = 100;
  server.setTimeout(150000, (socket) => socket.destroy());
  // No request, Authorization or parser exception logging.
  server.on("clientError", (_error, socket) => socket.destroy());
  return server;
}
