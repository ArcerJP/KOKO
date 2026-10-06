import { object, readApiSettings, uuid, type AccountEnv } from "./api-context";
import {
  createCloudRunClient,
  createWorkloadIdentityToken,
  type CloudRunClient,
  type ProcessingJob,
} from "./cloud-run-client";
import type { MediaProcessingMessage } from "./media-dispatch";
import { createProcessingRelayClient } from "@koko/processing/relay";

export type MediaConsumerEnv = AccountEnv & {
  KOKO_MEDIA_CONSUMER_ENABLED?: string;
  KOKO_MEDIA_PROCESSING_QUEUE?: string;
  KOKO_EVENT_ID?: string;
  KOKO_IMAGE_SERVICE_URL?: string;
  KOKO_IMAGE_CALLER_EMAIL?: string;
  KOKO_IMAGE_CALLER_SUBJECT?: string;
  KOKO_GOOGLE_WIF_PROVIDER_AUDIENCE?: string;
  KOKO_GOOGLE_WIF_SUBJECT_ISSUER?: string;
  KOKO_GOOGLE_WIF_SUBJECT_AUDIENCE?: string;
  KOKO_GOOGLE_WIF_SUBJECT?: string;
  KOKO_PROCESSING_RELAY_ENABLED?: string;
  KOKO_PROCESSING_RELAY_ORIGIN?: string;
  KOKO_PROCESSING_RELAY_SECRET?: string;
  KOKO_PROCESSING_RELAY_PROTECTION_BYPASS?: string;
};
export type MediaConsumerDependencies = {
  /** Trusted configured source. No deployment source is invented or read from a Queue message. */
  subjectToken?: (signal: AbortSignal) => Promise<string>;
  cloudRun?: CloudRunClient;
  prepareVideo?: (
    job: ProcessingJob,
  ) => Promise<"prepared" | "held" | "retry" | "stale">;
};
const id = (x: unknown): x is string =>
  typeof x === "string" &&
  x.length === 36 &&
  uuid.test(x) &&
  x === x.toLowerCase();
const exact = (value: object, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((k) => Object.hasOwn(value, k));
function message(
  value: unknown,
  eventId: string,
): MediaProcessingMessage | null {
  if (
    !object(value) ||
    !exact(value, [
      "version",
      "kind",
      "job_id",
      "event_id",
      "post_id",
      "asset_id",
      "post_version",
    ]) ||
    value.version !== 1 ||
    value.kind !== "process_media" ||
    value.event_id !== eventId ||
    ![value.job_id, value.event_id, value.post_id, value.asset_id].every(id) ||
    typeof value.post_version !== "number" ||
    !Number.isSafeInteger(value.post_version) ||
    value.post_version < 1 ||
    value.post_version > 2147483647
  )
    return null;
  return Object.freeze({ ...value }) as MediaProcessingMessage;
}
type Status =
  | { code: "READY"; kind: "photo" | "video" }
  | {
      code:
        | "TERMINAL"
        | "HELD"
        | "SUPERSEDED"
        | "DEFERRED"
        | "NOT_FOUND"
        | "INVALID_INPUT";
    };
const failure = () => new Error("MEDIA_CONSUMER_UNAVAILABLE");
function statusClient(
  settings: NonNullable<ReturnType<typeof readApiSettings>>,
  fetcher: typeof fetch,
) {
  const endpoint = new URL("/rest/v1/rpc/media_processing_status", settings.url)
    .href;
  return async (hint: MediaProcessingMessage): Promise<Status> => {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        (async () => {
          const response = await fetcher(endpoint, {
            method: "POST",
            redirect: "manual",
            cache: "no-store",
            signal: controller.signal,
            headers: {
              apikey: settings.secretKey,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({
              p_event_id: hint.event_id,
              p_post_id: hint.post_id,
              p_job_id: hint.job_id,
              p_asset_id: hint.asset_id,
              p_post_version: hint.post_version,
            }),
          });
          if (controller.signal.aborted) {
            void response.body?.cancel().catch(() => {});
            throw failure();
          }
          reader = response.body?.getReader();
          const length = response.headers.get("content-length");
          if (
            response.status !== 200 ||
            response.redirected ||
            (response.url && response.url !== endpoint) ||
            !reader ||
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
              response.headers.get("content-type") ?? "",
            ) ||
            (length !== null &&
              (!/^\d+$/.test(length) || Number(length) > 4096))
          )
            throw failure();
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const next = await reader.read();
            if (controller.signal.aborted) throw failure();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 4096) throw failure();
            chunks.push(next.value);
          }
          if (length !== null && Number(length) !== size) throw failure();
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
              bytes,
            ),
          ) as unknown;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(failure());
            controller.abort();
          }, 5000);
        }),
      ]);
      if (!object(result)) throw failure();
      if (result.code === "READY") {
        if (
          !exact(result, ["code", "kind"]) ||
          !["photo", "video"].includes(result.kind as string)
        )
          throw failure();
        return result as Status;
      }
      if (
        !exact(result, ["code"]) ||
        ![
          "TERMINAL",
          "HELD",
          "SUPERSEDED",
          "DEFERRED",
          "NOT_FOUND",
          "INVALID_INPUT",
        ].includes(result.code as string)
      )
        throw failure();
      return result as Status;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  };
}
const settled = (s: Status) =>
  ["TERMINAL", "HELD", "SUPERSEDED"].includes(s.code);

/** Resolving a batch implicitly ACKs it: fail closed before inspecting messages if routing/config is missing. */
export async function handleMediaProcessingQueue(
  batch: MessageBatch<unknown>,
  env: MediaConsumerEnv,
  dependencies: MediaConsumerDependencies = {},
  fetcher: typeof fetch = fetch,
) {
  if (
    env.KOKO_MEDIA_CONSUMER_ENABLED !== "true" ||
    !env.KOKO_MEDIA_PROCESSING_QUEUE ||
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(env.KOKO_MEDIA_PROCESSING_QUEUE) ||
    batch.queue !== env.KOKO_MEDIA_PROCESSING_QUEUE ||
    !id(env.KOKO_EVENT_ID) ||
    batch.messages.length > 10
  )
    throw new Error("MEDIA_CONSUMER_NOT_READY");
  const settings = readApiSettings(env);
  if (!settings) throw new Error("MEDIA_CONSUMER_NOT_READY");
  const readStatus = statusClient(settings, fetcher);
  const counts = { processed: 0, settled: 0, ignored: 0, retry: 0, failed: 0 };
  const batchDeadline = Date.now() + 600000;
  let client = dependencies.cloudRun;
  const configuredClient = () => {
    if (client) return client;
    // Production has no ambient Google identity. Only the fixed HMAC relay is wired.
    if (!dependencies.subjectToken) {
      client =
        createProcessingRelayClient({
          enabled: env.KOKO_PROCESSING_RELAY_ENABLED === "true",
          origin: env.KOKO_PROCESSING_RELAY_ORIGIN ?? "",
          secret: env.KOKO_PROCESSING_RELAY_SECRET ?? "",
          eventId: env.KOKO_EVENT_ID ?? "",
          ...(env.KOKO_PROCESSING_RELAY_PROTECTION_BYPASS
            ? { protectionBypass: env.KOKO_PROCESSING_RELAY_PROTECTION_BYPASS }
            : {}),
          fetcher,
        }) ?? undefined;
      if (!client) throw failure();
      return client;
    }
    // Explicit test/adapter injection only; index never injects an external assertion.
    const token = createWorkloadIdentityToken({
      enabled: true,
      serviceUrl: env.KOKO_IMAGE_SERVICE_URL ?? "",
      serviceAccountEmail: env.KOKO_IMAGE_CALLER_EMAIL ?? "",
      serviceAccountSubject: env.KOKO_IMAGE_CALLER_SUBJECT ?? "",
      providerAudience: env.KOKO_GOOGLE_WIF_PROVIDER_AUDIENCE ?? "",
      subjectIssuer: env.KOKO_GOOGLE_WIF_SUBJECT_ISSUER ?? "",
      subjectAudience: env.KOKO_GOOGLE_WIF_SUBJECT_AUDIENCE ?? "",
      subject: env.KOKO_GOOGLE_WIF_SUBJECT ?? "",
      ...(dependencies.subjectToken
        ? { subjectToken: dependencies.subjectToken }
        : {}),
      fetcher,
    });
    client = createCloudRunClient({
      enabled: true,
      serviceUrl: env.KOKO_IMAGE_SERVICE_URL ?? "",
      idToken: token!,
      fetcher,
    })!;
    return client;
  };
  for (const queued of batch.messages) {
    if (Date.now() >= batchDeadline) {
      queued.retry({ delaySeconds: 60 });
      counts.retry++;
      continue;
    }
    const hint = message(queued.body, env.KOKO_EVENT_ID);
    if (!hint) {
      queued.ack();
      counts.ignored++;
      continue;
    }
    let ack = false,
      ignored = false;
    try {
      let current = await readStatus(hint);
      if (settled(current)) ack = true;
      else if (
        current.code === "NOT_FOUND" ||
        current.code === "INVALID_INPUT"
      ) {
        ack = true;
        ignored = true;
      } else if (current.code === "READY") {
        const job: ProcessingJob = {
          eventId: hint.event_id,
          postId: hint.post_id,
          jobId: hint.job_id,
        };
        if (current.kind === "video") {
          if (!dependencies.prepareVideo) throw failure();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          let preparation: string;
          try {
            preparation = await Promise.race([
              dependencies.prepareVideo(job),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(failure()), 90000);
              }),
            ]);
          } finally {
            if (timeout !== undefined) clearTimeout(timeout);
          }
          if (!["prepared", "retry", "held", "stale"].includes(preparation))
            throw failure();
          current = await readStatus(hint);
          if (settled(current)) ack = true;
          else if (
            preparation !== "prepared" ||
            current.code !== "READY" ||
            current.kind !== "video"
          )
            throw failure();
        }
        if (!ack) {
          try {
            await configuredClient().process(job);
            counts.processed++;
          } catch {
            counts.failed++;
          }
          // Even a lost HTTP response may have committed; conversely HTTP 200 is not proof.
          const after = await readStatus(hint);
          ack = settled(after);
        }
      }
    } catch {
      counts.failed++;
    }
    if (ack) {
      queued.ack();
      if (ignored) counts.ignored++;
      else counts.settled++;
    } else {
      queued.retry({ delaySeconds: 60 });
      counts.retry++;
    }
  }
  return counts;
}
