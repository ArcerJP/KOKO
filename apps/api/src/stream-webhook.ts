import { object, privateHeaders, uuid, type AccountEnv } from "./api-context";
import { createInternalRpc } from "./internal-rpc";
import type { MediaProcessingMessage } from "./media-dispatch";
import {
  createStreamWebhookVerifier,
  type VerifiedStreamNotification,
} from "./stream-processing";

export const streamWebhookPath = "/internal/stream-webhook";
export type StreamWebhookEnv = AccountEnv & {
  KOKO_STREAM_WEBHOOK_ENABLED?: string;
  /** Must be the Stream webhook secret from this same fixed R2/Stream account, not an API token. */
  KOKO_STREAM_WEBHOOK_SECRET?: string;
  KOKO_EVENT_ID?: string;
  R2_ACCOUNT_ID?: string;
  KOKO_STREAM_PLAYBACK_ORIGIN?: string;
  MEDIA_PROCESSING_QUEUE?: Pick<Queue<MediaProcessingMessage>, "sendBatch">;
};
const id = (x: unknown): x is string =>
  typeof x === "string" &&
  x.length === 36 &&
  uuid.test(x) &&
  x === x.toLowerCase();
const exact = (x: object, keys: readonly string[]) =>
  Object.keys(x).length === keys.length &&
  keys.every((k) => Object.hasOwn(x, k));
const response = (status: number) =>
  Response.json(
    status === 202
      ? { accepted: true }
      : {
          code:
            status === 404
              ? "NOT_FOUND"
              : status === 503
                ? "WEBHOOK_UNAVAILABLE"
                : "INVALID_WEBHOOK",
        },
    { status, headers: privateHeaders },
  );
function playbackHost(origin: string | undefined) {
  if (!origin) throw new Error("CONFIG");
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      url.hostname,
    )
  )
    throw new Error("CONFIG");
  return url.hostname;
}
function hint(
  value: unknown,
  notification: VerifiedStreamNotification,
): MediaProcessingMessage | null {
  if (!object(value) || typeof value.code !== "string") throw new Error("RPC");
  if (value.code === "IGNORED" && exact(value, ["code"])) return null;
  if (
    value.code !== "READY" ||
    !exact(value, ["code", "message"]) ||
    !object(value.message)
  )
    throw new Error("RPC");
  const message = value.message;
  if (
    !exact(message, [
      "version",
      "kind",
      "job_id",
      "event_id",
      "post_id",
      "asset_id",
      "post_version",
    ]) ||
    message.version !== 1 ||
    message.kind !== "process_media" ||
    message.event_id !== notification.eventId ||
    message.post_id !== notification.postId ||
    message.asset_id !== notification.assetId ||
    !id(message.job_id) ||
    !Number.isSafeInteger(message.post_version) ||
    Number(message.post_version) < notification.postVersion ||
    Number(message.post_version) > 2147483647
  )
    throw new Error("RPC");
  return Object.freeze({ ...message }) as MediaProcessingMessage;
}
async function enqueue(
  queue: NonNullable<StreamWebhookEnv["MEDIA_PROCESSING_QUEUE"]>,
  message: MediaProcessingMessage,
  signal: AbortSignal,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("QUEUE"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      timer = setTimeout(abort, 10000);
    });
    await Promise.race([
      stopped,
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return queue.sendBatch([{ body: message, contentType: "json" }]);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** A signed webhook is only an at-least-once hint. Do not expose this route by weakening Access.
 * Activating public ingress and provisioning the account-scoped secret require separate approval. */
export async function handleStreamWebhook(
  request: Request,
  env: StreamWebhookEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (env.KOKO_STREAM_WEBHOOK_ENABLED !== "true") return response(404);
  let verify: NonNullable<ReturnType<typeof createStreamWebhookVerifier>>;
  let rpc: ReturnType<typeof createInternalRpc>;
  let queue: NonNullable<StreamWebhookEnv["MEDIA_PROCESSING_QUEUE"]>;
  try {
    if (
      !id(env.KOKO_EVENT_ID) ||
      !env.R2_ACCOUNT_ID ||
      !/^[a-f0-9]{32}$/.test(env.R2_ACCOUNT_ID) ||
      !env.MEDIA_PROCESSING_QUEUE ||
      typeof env.MEDIA_PROCESSING_QUEUE.sendBatch !== "function"
    )
      throw new Error("CONFIG");
    queue = env.MEDIA_PROCESSING_QUEUE;
    verify = createStreamWebhookVerifier({
      enabled: true,
      secret: env.KOKO_STREAM_WEBHOOK_SECRET ?? "",
      allowedOrigins: [playbackHost(env.KOKO_STREAM_PLAYBACK_ORIGIN)],
    })!;
    rpc = createInternalRpc(env, fetcher);
  } catch {
    return response(503);
  }
  const url = new URL(request.url);
  let headerBytes = 0;
  for (const [name, value] of request.headers) {
    headerBytes += new TextEncoder().encode(name + value).byteLength;
  }
  if (
    request.method !== "POST" ||
    url.protocol !== "https:" ||
    url.pathname !== streamWebhookPath ||
    url.search ||
    url.hash ||
    headerBytes > 8192 ||
    request.headers.has("origin") ||
    request.headers.has("cookie") ||
    request.headers.has("authorization")
  )
    return response(400);
  let notification: VerifiedStreamNotification;
  try {
    notification = await verify(request);
  } catch {
    return response(401);
  }
  // One account has one Stream webhook; unrelated applications/events must not get our DB/Queue scope.
  if (notification.eventId !== env.KOKO_EVENT_ID) return response(202);
  try {
    const value = await rpc(
      "resolve_stream_webhook",
      {
        p_event_id: notification.eventId,
        p_post_id: notification.postId,
        p_asset_id: notification.assetId,
        p_provider_job_id: notification.jobId,
        p_provider_post_version: notification.postVersion,
        p_operation_id: notification.video.reference.operationId,
        p_stream_uid: notification.video.reference.uid,
        p_source_uid: notification.video.reference.sourceUid,
      },
      request.signal,
    );
    const message = hint(value, notification);
    if (message) await enqueue(queue, message, request.signal);
    // Do not return UID, metadata, URLs, provider exceptions, or whether a private job exists.
    return response(202);
  } catch {
    return response(503);
  }
}
