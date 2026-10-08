import type { ImageJobReference } from "./db.js";
import type { ImageRunResult } from "./runner.js";
import type { ModerationRunResult } from "./moderation-runner.js";

export type ImageServiceOptions = {
  enabled?: boolean;
  authenticate?: (authorization: string | null) => Promise<boolean>;
  run?: (job: ImageJobReference) => Promise<ImageRunResult>;
  processEnabled?: boolean;
  processRun?: (
    job: ImageJobReference,
    signal: AbortSignal,
  ) => Promise<ModerationRunResult>;
  bodyTimeoutMs?: number;
};
const json = (body: object, status: number, headers: HeadersInit = {}) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
const error = (code: string, status: number, headers?: HeadersInit) =>
  json({ error: { code } }, status, headers);
const id = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );

async function readJob(
  request: Request,
  timeout: number,
): Promise<ImageJobReference> {
  const length = request.headers.get("content-length");
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers.get("content-type") ?? "",
    ) ||
    request.headers.has("content-encoding") ||
    !request.body ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > 1024))
  )
    throw new Error("INVALID_REQUEST");
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  try {
    return await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const next = await reader.read();
          if (cancelled || request.signal.aborted)
            throw new Error("INVALID_REQUEST");
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 1024) throw new Error("INVALID_REQUEST");
          chunks.push(next.value);
        }
        if (length !== null && Number(length) !== size)
          throw new Error("INVALID_REQUEST");
        const body: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length !== 3 ||
          !("eventId" in body) ||
          !("postId" in body) ||
          !("jobId" in body) ||
          !id(body.eventId) ||
          !id(body.postId) ||
          !id(body.jobId)
        )
          throw new Error("INVALID_REQUEST");
        return Object.freeze({
          eventId: body.eventId,
          postId: body.postId,
          jobId: body.jobId,
        });
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("INVALID_REQUEST")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    cancelled = true;
    void reader.cancel().catch(() => {});
  }
}

/** Private image-stage endpoint. A 200 is NOT process_media completion or Queue ACK. */
export function createImageService(
  options: ImageServiceOptions = {},
): (request: Request) => Promise<Response> {
  const enabled = options.enabled === true;
  const { authenticate, run, bodyTimeoutMs = 5000 } = options;
  const processEnabled = enabled && options.processEnabled === true;
  if (
    enabled &&
    (typeof authenticate !== "function" ||
      typeof run !== "function" ||
      !Number.isSafeInteger(bodyTimeoutMs) ||
      bodyTimeoutMs < 1 ||
      bodyTimeoutMs > 5000)
  )
    throw new Error("INVALID_SERVICE_CONFIG");
  if (processEnabled && typeof options.processRun !== "function")
    throw new Error("INVALID_SERVICE_CONFIG");
  let active = false;
  return async (request) => {
    const target = new URL(request.url);
    if (
      target.pathname === "/health" &&
      !target.search &&
      request.method === "GET"
    )
      return json(
        { service: "koko-image", status: enabled ? "ready" : "disabled" },
        200,
      );
    const fullProcess = target.pathname === "/internal/process";
    if (
      !enabled ||
      (target.pathname !== "/internal/image" && !fullProcess) ||
      (fullProcess && !processEnabled) ||
      target.search
    )
      return error("NOT_FOUND", 404);
    if (request.method !== "POST")
      return error("METHOD_NOT_ALLOWED", 405, { allow: "POST" });
    // No browser cookies, forwarded identity, Origin or CORS-based authentication.
    if (
      request.headers.has("cookie") ||
      request.headers.has("origin") ||
      request.headers.has("x-serverless-authorization")
    )
      return error("AUTH_REQUIRED", 401);
    if (active) return error("BUSY", 429, { "retry-after": "5" });
    active = true;
    try {
      if (
        request.signal.aborted ||
        (await authenticate!(request.headers.get("authorization"))) !== true
      )
        return error("AUTH_REQUIRED", 401);
      let job: ImageJobReference;
      try {
        job = await readJob(request, bodyTimeoutMs);
      } catch {
        return error("INVALID_REQUEST", 400);
      }
      if (request.signal.aborted) return error("INVALID_REQUEST", 400);
      if (fullProcess) {
        const result = await options.processRun!(job, request.signal);
        if (
          result?.ok &&
          ["moderation_recorded", "moderation_already_recorded"].includes(
            result.outcome,
          )
        )
          return json(
            {
              stage: "moderation",
              outcome: result.outcome,
              processComplete: true,
            },
            200,
          );
        if (!result?.ok && result?.reason === "STALE")
          return error("STALE", 409);
        if (!result?.ok && result?.reason === "INVALID_INPUT")
          return error("INVALID_REQUEST", 400);
        return error("RETRY_LATER", 503, { "retry-after": "5" });
      }
      const result = await run!(job);
      if (
        result.ok &&
        ["image_recorded", "image_already_recorded"].includes(result.outcome)
      )
        return json(
          { stage: "image", outcome: result.outcome, processComplete: false },
          200,
        );
      if (!result.ok) {
        // Fixed allowlisted reasons only. Never serialize runner objects or AI bytes.
        if (
          [
            "BUSY",
            "DB_TIMEOUT",
            "TIMEOUT",
            "DB_FAILED",
            "STORAGE_FAILED",
          ].includes(result.reason)
        )
          return error("RETRY_LATER", 503, { "retry-after": "5" });
        if (result.reason === "STALE") return error("STALE", 409);
        if (result.reason === "INVALID_INPUT")
          return error("INVALID_REQUEST", 400);
      }
      return error("PROCESSING_FAILED", 503);
    } catch {
      return error("PROCESSING_FAILED", 503);
    } finally {
      active = false;
    }
  };
}
