import { object, uuid } from "./api-context";
import { createInternalRpc, type InternalRpc } from "./internal-rpc";
import {
  deletionProviderConfigured,
  type DeletionProviderEnv,
} from "./deletion-provider";
import {
  type PhysicalDeletionEnv,
  physicalDeletionCron,
} from "./physical-deletion";

type OrphanPlan = {
  event_id: string;
  post_id: string;
  job_id: string;
  operation_id: string;
  original_asset_id: string;
  post_version: number;
  source_uid: string | null;
};
type Observation = {
  result:
    "NOT_FOUND" | "MATCHED_CANDIDATE" | "DUPLICATE" | "MISMATCH" | "UNKNOWN";
  candidate_uid: string | null;
};
const id = (v: unknown): v is string =>
  typeof v === "string" && uuid.test(v) && v === v.toLowerCase();
const uid = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{32}$/.test(v);
function plan(v: unknown): v is OrphanPlan {
  return (
    object(v) &&
    Object.keys(v).length === 7 &&
    [
      v.event_id,
      v.post_id,
      v.job_id,
      v.operation_id,
      v.original_asset_id,
    ].every(id) &&
    typeof v.post_version === "number" &&
    Number.isInteger(v.post_version) &&
    v.post_version > 0 &&
    v.post_version <= 2147483647 &&
    (v.source_uid === null || uid(v.source_uid))
  );
}
const unknown = (): Observation => ({ result: "UNKNOWN", candidate_uid: null });

/** At most two named Stream candidates. GET only. A match NEVER authorizes deletion. */
export async function observeStreamOrphan(
  target: OrphanPlan,
  env: DeletionProviderEnv,
  fetcher: typeof fetch = fetch,
): Promise<Observation> {
  if (!plan(target) || !deletionProviderConfigured(env)) return unknown();
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    abort.abort();
    void reader?.cancel().catch(() => {});
  };
  try {
    return await Promise.race([
      (async (): Promise<Observation> => {
        const response = await fetcher(
          `https://api.cloudflare.com/client/v4/accounts/${env.R2_ACCOUNT_ID}/stream?video_name=${encodeURIComponent(`koko-${target.operation_id}`)}&limit=2`,
          {
            method: "GET",
            headers: {
              authorization: `Bearer ${env.KOKO_DELETION_API_TOKEN}`,
              accept: "application/json",
            },
            redirect: "manual",
            cache: "no-store",
            signal: abort.signal,
          },
        );
        reader = response.body?.getReader();
        try {
          abort.signal.throwIfAborted();
          if (
            response.redirected ||
            response.status !== 200 ||
            !reader ||
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
              response.headers.get("content-type") ?? "",
            )
          )
            return unknown();
          let text = "",
            size = 0;
          const decoder = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: false,
          });
          for (;;) {
            const chunk = await reader.read();
            abort.signal.throwIfAborted();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 65536) return unknown();
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
          const data: unknown = JSON.parse(text);
          if (
            !object(data) ||
            data.success !== true ||
            !Array.isArray(data.result) ||
            data.result.length > 2
          )
            return unknown();
          if (data.result.length === 0)
            return { result: "NOT_FOUND", candidate_uid: null };
          if (data.result.length === 2)
            return { result: "DUPLICATE", candidate_uid: null };
          const video: unknown = data.result[0];
          const expected = {
            name: `koko-${target.operation_id}`,
            koko_event: target.event_id,
            koko_post: target.post_id,
            koko_asset: target.original_asset_id,
            koko_job: target.job_id,
            koko_operation: target.operation_id,
            koko_version: String(target.post_version),
            koko_source: target.source_uid ?? "original",
          };
          if (
            !object(video) ||
            !uid(video.uid) ||
            video.requireSignedURLs !== true ||
            !object(video.meta) ||
            Object.entries(expected).some(
              ([key, value]) =>
                (video.meta as Record<string, unknown>)[key] !== value,
            ) ||
            (target.source_uid === null
              ? video.clippedFrom !== null &&
                video.clippedFrom !== undefined &&
                video.clippedFrom !== ""
              : video.clippedFrom !== target.source_uid)
          )
            return { result: "MISMATCH", candidate_uid: null };
          return { result: "MATCHED_CANDIDATE", candidate_uid: video.uid };
        } finally {
          void reader?.cancel().catch(() => {});
          reader?.releaseLock();
        }
      })(),
      new Promise<Observation>((resolve) => {
        timer = setTimeout(() => {
          stop();
          resolve(unknown());
        }, 10000);
      }),
    ]);
  } catch {
    return unknown();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    stop();
  }
}

/** Read-only provider observations + DB receipt. No delete/copy/abort, no discovered UID in result. */
export async function handleCleanupOrphansScheduled(
  controller: Pick<ScheduledController, "cron">,
  env: PhysicalDeletionEnv,
  fetcher: typeof fetch = fetch,
  dependencies?: { rpc?: InternalRpc },
) {
  if (
    env.KOKO_PHYSICAL_DELETION_ENABLED !== "true" ||
    controller.cron !== physicalDeletionCron
  )
    return null;
  const counts = { claimed: 0, recorded: 0, failed: 0, configured: false };
  if (!id(env.KOKO_EVENT_ID) || !deletionProviderConfigured(env)) return counts;
  counts.configured = true;
  try {
    const rpc = dependencies?.rpc ?? createInternalRpc(env, fetcher);
    const call = (action: string, input: object) =>
      rpc("reconcile_cleanup_orphans", {
        p_event_id: env.KOKO_EVENT_ID,
        p_action: action,
        p_input: input,
      });
    const c = await call("claim", {});
    if (c.code === "DISABLED") return counts;
    if (c.code !== "CLAIMED" || !Array.isArray(c.claims) || c.claims.length > 3)
      throw new Error();
    const seen = new Set<string>();
    for (const claim of c.claims) {
      if (
        !object(claim) ||
        Object.keys(claim).length !== 2 ||
        !id(claim.lease_id) ||
        !plan(claim.plan) ||
        claim.plan.event_id !== env.KOKO_EVENT_ID ||
        seen.has(`${claim.plan.job_id}:${claim.plan.operation_id}`)
      )
        throw new Error();
      seen.add(`${claim.plan.job_id}:${claim.plan.operation_id}`);
    }
    counts.claimed = c.claims.length;
    for (const claim of c.claims) {
      const typed = claim as { plan: OrphanPlan; lease_id: string };
      try {
        const observation = await observeStreamOrphan(typed.plan, env, fetcher);
        const r = await call("record", { ...typed, ...observation });
        if (r.code === "RECORDED") counts.recorded++;
        else counts.failed++;
      } catch {
        counts.failed++;
      }
    }
  } catch {
    counts.failed++;
  }
  return counts;
}
