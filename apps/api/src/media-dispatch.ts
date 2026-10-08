import { object, readApiSettings, uuid, type AccountEnv } from "./api-context";

/** Stable hint only. A consumer must reload the authoritative job/post/asset. */
export type MediaProcessingMessage = {
  version: 1;
  kind: "process_media";
  job_id: string;
  event_id: string;
  post_id: string;
  asset_id: string;
  post_version: number;
};
export type MediaDispatchEnv = AccountEnv & {
  KOKO_MEDIA_DISPATCH_ENABLED?: string;
  KOKO_EVENT_ID?: string;
  MEDIA_PROCESSING_QUEUE?: Pick<Queue<MediaProcessingMessage>, "sendBatch">;
};
export const mediaDispatchCron = "* * * * *";
// Admit the 30 posts/minute target with bounded retry headroom, not an unbounded drain.
const limit = 50;
const summary = () => ({
  claimed: 0,
  sent: 0,
  retry: 0,
  invalid: 0,
  settled: 0,
  stale: 0,
  exhausted: false,
  failed: false,
});
const id = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length === 36 &&
  uuid.test(value) &&
  value === value.toLowerCase();
const integer = (value: unknown, max: number): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= max;
const invalid = () => new Error("MEDIA_DISPATCH_FAILED");

async function deadline<T>(
  operation: Promise<T>,
  ms: number,
  expire = () => {},
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(invalid());
          expire();
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function dispatchClient(
  settings: NonNullable<ReturnType<typeof readApiSettings>>,
  fetcher: typeof fetch,
) {
  return async (
    name: "claim_media_dispatch" | "settle_media_dispatch",
    input: object,
  ): Promise<unknown> => {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      return await deadline(
        (async () => {
          const response = await fetcher(
            new URL(`/rest/v1/rpc/${name}`, settings.url),
            {
              method: "POST",
              redirect: "manual",
              cache: "no-store",
              signal: controller.signal,
              headers: {
                apikey: settings.secretKey,
                accept: "application/json",
                "content-type": "application/json",
              },
              body: JSON.stringify(input),
            },
          );
          if (controller.signal.aborted) {
            void response.body?.cancel().catch(() => {});
            throw invalid();
          }
          reader = response.body?.getReader();
          if (
            response.status !== 200 ||
            !/^application\/json(?:\s*;|$)/i.test(
              response.headers.get("content-type") ?? "",
            ) ||
            !reader
          )
            throw invalid();
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (controller.signal.aborted) throw invalid();
            if (done) break;
            size += value.byteLength;
            if (size > 65536) throw invalid();
            chunks.push(value);
          }
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
        5000,
        () => controller.abort(),
      );
    } finally {
      controller.abort();
      // Cancellation itself must not defeat the deadline on an uncooperative stream.
      void reader?.cancel().catch(() => {});
    }
  };
}

function claims(result: unknown, eventId: string) {
  if (
    !object(result) ||
    result.code !== "ok" ||
    typeof result.exhausted !== "boolean" ||
    !Array.isArray(result.jobs) ||
    result.jobs.length > limit
  )
    throw invalid();
  const seen = new Set<string>();
  const jobs = result.jobs.map((job: unknown) => {
    if (
      !object(job) ||
      !id(job.job_id) ||
      job.event_id !== eventId ||
      seen.has(job.job_id) ||
      !integer(job.attempt, 8) ||
      job.attempt < 1
    )
      throw invalid();
    seen.add(job.job_id);
    const message: MediaProcessingMessage | null =
      id(job.event_id) &&
      id(job.post_id) &&
      id(job.asset_id) &&
      integer(job.post_version, 2147483647) &&
      job.post_version >= 1
        ? {
            version: 1,
            kind: "process_media",
            job_id: job.job_id,
            event_id: job.event_id,
            post_id: job.post_id,
            asset_id: job.asset_id,
            post_version: job.post_version,
          }
        : null;
    return { job_id: job.job_id, attempt: job.attempt, message };
  });
  return { jobs, exhausted: result.exhausted };
}

export async function handleMediaDispatchScheduled(
  controller: Pick<ScheduledController, "cron">,
  env: MediaDispatchEnv,
  fetcher: typeof fetch = fetch,
) {
  if (
    env.KOKO_MEDIA_DISPATCH_ENABLED !== "true" ||
    controller.cron !== mediaDispatchCron
  )
    return null;
  const counts = summary();
  try {
    const settings = readApiSettings(env);
    const queue = env.MEDIA_PROCESSING_QUEUE;
    if (
      !id(env.KOKO_EVENT_ID) ||
      !settings ||
      !queue ||
      typeof queue.sendBatch !== "function"
    )
      throw invalid();
    const rpc = dispatchClient(settings, fetcher);
    const claimed = claims(
      await rpc("claim_media_dispatch", {
        p_event_id: env.KOKO_EVENT_ID,
        p_limit: limit,
      }),
      env.KOKO_EVENT_ID,
    );
    counts.exhausted = claimed.exhausted;
    counts.claimed = claimed.jobs.length;
    if (!counts.claimed) return counts;
    const messages = claimed.jobs.flatMap(({ message }) =>
      message ? [{ body: message, contentType: "json" as const }] : [],
    );
    counts.invalid = counts.claimed - messages.length;
    let sent = false;
    if (messages.length) {
      try {
        // A timed-out send can still arrive. Never assume exactly-once delivery.
        await deadline(queue.sendBatch(messages), 10000);
        sent = true;
      } catch {
        counts.failed = true;
      }
    }
    counts.sent = sent ? messages.length : 0;
    counts.retry = counts.claimed - counts.sent;
    const settled = await rpc("settle_media_dispatch", {
      p_event_id: env.KOKO_EVENT_ID,
      p_claims: claimed.jobs.map((job) => ({
        job_id: job.job_id,
        attempt: job.attempt,
        outcome: sent && job.message ? "sent" : "retry",
      })),
    });
    if (
      !object(settled) ||
      settled.code !== "ok" ||
      !integer(settled.settled, counts.claimed) ||
      !integer(settled.stale, counts.claimed) ||
      settled.settled + settled.stale !== counts.claimed
    )
      throw invalid();
    counts.settled = settled.settled;
    counts.stale = settled.stale;
  } catch {
    counts.failed = true;
  }
  // Numbers and fixed booleans only: no IDs, payloads, URLs, secrets or exceptions.
  return counts;
}
