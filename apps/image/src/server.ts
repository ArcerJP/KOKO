import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { createImageDatabase } from "./db.js";
import { createImageR2Store, type ImageR2Env } from "./r2.js";
import { createImageRunner } from "./runner.js";
import { createGoogleCallerVerifier } from "./service-auth.js";
import { createImageService } from "./service.js";
import { createModerationDatabase } from "./moderation-db.js";
import { createModerationRunner } from "./moderation-runner.js";
import { createPrivateModerationFrames } from "./moderation-frames.js";

export type ImageServiceEnv = ImageR2Env & {
  KOKO_IMAGE_SERVICE_ENABLED?: string;
  KOKO_IMAGE_SERVICE_AUDIENCE?: string;
  KOKO_IMAGE_CALLER_EMAIL?: string;
  KOKO_IMAGE_CALLER_SUBJECT?: string;
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  KOKO_MEDIA_PROCESSING_ENABLED?: string;
  KOKO_VISION_METADATA_ENABLED?: string;
  OPENAI_API_KEY?: string;
  KOKO_VIDEO_MODERATION_ENABLED?: string;
  KOKO_STREAM_MODERATION_API_TOKEN?: string;
  KOKO_STREAM_CUSTOMER_HOST?: string;
  KOKO_STREAM_ALLOWED_ORIGINS?: string;
};

/** Cloud Run service identity only; never accepts an endpoint, account or token from a request. */
export function createVisionMetadataToken(
  fetcher: typeof fetch = fetch,
  timeoutMs = 5000,
) {
  if (
    typeof fetcher !== "function" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5000
  )
    throw new Error("INVALID_METADATA_CONFIG");
  const endpoint =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
  return async (outer: AbortSignal): Promise<string> => {
    const controller = new AbortController();
    const stop = () => controller.abort();
    outer.addEventListener("abort", stop, { once: true });
    if (outer.aborted) stop();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          if (controller.signal.aborted) throw new Error();
          const response = await fetcher(endpoint, {
            redirect: "manual",
            cache: "no-store",
            credentials: "omit",
            signal: controller.signal,
            headers: {
              "Metadata-Flavor": "Google",
              accept: "application/json",
            },
          });
          if (controller.signal.aborted) {
            void response.body?.cancel().catch(() => {});
            throw new Error();
          }
          reader = response.body?.getReader();
          const length = response.headers.get("content-length");
          if (
            response.status !== 200 ||
            response.redirected ||
            (response.url && response.url !== endpoint) ||
            response.headers.get("metadata-flavor") !== "Google" ||
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
              response.headers.get("content-type") ?? "",
            ) ||
            !reader ||
            (length !== null &&
              (!/^\d+$/.test(length) || Number(length) > 16384))
          )
            throw new Error();
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const part = await reader.read();
            if (controller.signal.aborted) throw new Error();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 16384) throw new Error();
            chunks.push(part.value);
          }
          if (length !== null && Number(length) !== size) throw new Error();
          const data: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          );
          if (!data || typeof data !== "object" || Array.isArray(data))
            throw new Error();
          const token = data as Record<string, unknown>;
          if (
            Object.keys(token).length !== 3 ||
            token.token_type !== "Bearer" ||
            typeof token.access_token !== "string" ||
            !/^[A-Za-z0-9._~+/-]{8,8192}={0,2}$/.test(token.access_token) ||
            !Number.isInteger(token.expires_in) ||
            (token.expires_in as number) < 60 ||
            (token.expires_in as number) > 3600
          )
            throw new Error();
          return token.access_token;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error());
            controller.abort();
          }, timeoutMs);
        }),
      ]);
    } catch {
      throw new Error("METADATA_TOKEN_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", stop);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  };
}

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
  if (env.KOKO_MEDIA_PROCESSING_ENABLED !== "true")
    return createImageService({ enabled: true, authenticate, run: runner.run });
  if (
    env.KOKO_VISION_METADATA_ENABLED !== "true" ||
    typeof env.OPENAI_API_KEY !== "string" ||
    !/^sk-[A-Za-z0-9_-]{8,512}$/.test(env.OPENAI_API_KEY)
  )
    throw new Error("INVALID_MODERATION_SERVICE_CONFIG");
  const openaiSecret = env.OPENAI_API_KEY;
  const moderationDatabase = createModerationDatabase({
    enabled: true,
    supabaseUrl: env.SUPABASE_URL ?? "",
    secretKey: env.SUPABASE_SECRET_KEY ?? "",
  })!;
  const streamSecret = env.KOKO_STREAM_MODERATION_API_TOKEN;
  if (
    env.KOKO_VIDEO_MODERATION_ENABLED === "true" &&
    (typeof streamSecret !== "string" ||
      !/^[A-Za-z0-9_-]{8,1024}$/.test(streamSecret))
  )
    throw new Error("INVALID_MODERATION_SERVICE_CONFIG");
  const getVideoFrames = createPrivateModerationFrames({
    enabled: env.KOKO_VIDEO_MODERATION_ENABLED === "true",
    accountId: env.R2_ACCOUNT_ID ?? "",
    customerHost: env.KOKO_STREAM_CUSTOMER_HOST ?? "",
    allowedOrigins: (env.KOKO_STREAM_ALLOWED_ORIGINS ?? "").split(","),
    apiToken: async (signal) => {
      if (signal.aborted || !streamSecret) throw new Error("ABORTED");
      return streamSecret;
    },
    isCurrent: moderationDatabase.check,
  });
  const moderationRunner = createModerationRunner({
    enabled: true,
    database: moderationDatabase,
    imageRun: runner.run,
    getOriginal: store!.getOriginal,
    openaiToken: async (signal) => {
      if (signal.aborted) throw new Error("ABORTED");
      return openaiSecret;
    },
    visionToken: createVisionMetadataToken(),
    ...(getVideoFrames ? { getVideoFrames } : {}),
  })!;
  return createImageService({
    enabled: true,
    authenticate,
    run: runner.run,
    processEnabled: true,
    processRun: moderationRunner.run,
  });
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
        if (
          path !== "/health" &&
          path !== "/internal/image" &&
          path !== "/internal/process"
        )
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
