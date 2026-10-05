import { object, uuid, type AccountEnv } from "./api-context";
import { createInternalRpc, type InternalRpc } from "./internal-rpc";
import {
  createStreamProcessingAdapter,
  StreamProcessingError,
  type StreamObservation,
  type StreamReference,
  type StreamScope,
} from "./stream-processing";

export type ProcessingJob = { eventId: string; postId: string; jobId: string };
export type StreamRunnerEnv = AccountEnv & {
  KOKO_STREAM_PROCESSING_ENABLED?: string;
  R2_ACCOUNT_ID?: string;
  KOKO_STREAM_API_TOKEN?: string;
  KOKO_STREAM_CUSTOMER_HOST?: string;
  KOKO_STREAM_PLAYBACK_ORIGIN?: string;
  KOKO_STREAM_R2_READ_ACCESS_KEY_ID?: string;
  KOKO_STREAM_R2_READ_SECRET_ACCESS_KEY?: string;
  ORIGINALS_BUCKET?: Pick<R2Bucket, "head">;
};
type Plan = {
  scope: StreamScope;
  original: { size: number; etag: string; objectVersion: string };
  originalScope: "client_trimmed" | "full_video_fallback";
};
type Operation = {
  operationId: string;
  uid: string | null;
  sourceUid: string | null;
};
export type StreamRunnerResult = "prepared" | "held" | "retry" | "stale";
const bad = (): never => {
  throw new Error("INVALID_STREAM_PLAN");
};
const id = (x: unknown): x is string =>
  typeof x === "string" && uuid.test(x) && x === x.toLowerCase();
const uid = (x: unknown): x is string =>
  typeof x === "string" && /^[a-f0-9]{32}$/.test(x);
function parseOperation(
  value: unknown,
  operation: "source" | "clip",
): Operation {
  if (
    !object(value) ||
    !id(value.operationId) ||
    (value.uid !== null && !uid(value.uid)) ||
    (operation === "source"
      ? value.sourceUid !== null
      : !uid(value.sourceUid)) ||
    (value.uid !== null && value.uid === value.sourceUid) ||
    !id(value.providerJobId) ||
    !Number.isSafeInteger(value.providerPostVersion) ||
    Number(value.providerPostVersion) < 1 ||
    Number(value.providerPostVersion) > 2147483647
  )
    return bad();
  return {
    operationId: value.operationId,
    uid: value.uid as string | null,
    sourceUid: value.sourceUid as string | null,
  };
}
function parsePlan(value: unknown, job: ProcessingJob): Plan {
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !== "original,originalScope,scope" ||
    !object(value.scope) ||
    !object(value.original) ||
    Object.keys(value.original).sort().join(",") !== "etag,objectVersion,size"
  )
    return bad();
  const s = value.scope,
    a = value.original;
  if (
    Object.keys(s).length !== 7 ||
    s.eventId !== job.eventId ||
    s.postId !== job.postId ||
    s.jobId !== job.jobId ||
    !id(s.assetId) ||
    !id(s.leaseId) ||
    !Number.isSafeInteger(s.postVersion) ||
    Number(s.postVersion) < 1 ||
    Number(s.postVersion) > 2147483647 ||
    !Number.isSafeInteger(s.expiresAt) ||
    Number(s.expiresAt) <= Date.now() ||
    Number(s.expiresAt) > Date.now() + 120000 ||
    !Number.isSafeInteger(a.size) ||
    Number(a.size) < 1 ||
    Number(a.size) > 5492189429760 ||
    typeof a.etag !== "string" ||
    !/^[a-f0-9]{32}(?:-[1-9][0-9]{0,4})?$/.test(a.etag) ||
    typeof a.objectVersion !== "string" ||
    !/^[!-~]{1,1024}$/.test(a.objectVersion) ||
    !["client_trimmed", "full_video_fallback"].includes(
      String(value.originalScope),
    )
  )
    return bad();
  return {
    scope: s as StreamScope,
    original: {
      size: Number(a.size),
      etag: a.etag,
      objectVersion: a.objectVersion,
    },
    originalScope: value.originalScope as Plan["originalScope"],
  };
}
type Adapter = NonNullable<ReturnType<typeof createStreamProcessingAdapter>>;
function playbackHost(origin: string | undefined) {
  if (!origin) return bad();
  const parsed = new URL(origin);
  if (
    parsed.origin !== origin ||
    parsed.protocol !== "https:" ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    !/^[a-z0-9.-]+$/.test(parsed.hostname)
  )
    return bad();
  return parsed.hostname;
}
async function originalHead(
  bucket: StreamRunnerEnv["ORIGINALS_BUCKET"],
  key: string,
) {
  if (!bucket) return bad();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      bucket.head(key),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("HEAD_TIMEOUT")), 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
/** One durable preparation turn: never sleep a Worker or repeat an ambiguous create. */
export async function runStreamPreparation(
  job: ProcessingJob,
  env: StreamRunnerEnv,
  fetcher: typeof fetch = fetch,
  dependencies: {
    rpc?: InternalRpc;
    adapter?: (plan: Plan, rpc: InternalRpc) => Adapter;
  } = {},
): Promise<StreamRunnerResult> {
  if (
    env.KOKO_STREAM_PROCESSING_ENABLED !== "true" ||
    !Object.values(job).every(id) ||
    Object.keys(job).sort().join(",") !== "eventId,jobId,postId"
  )
    return "retry";
  try {
    const rpc = dependencies.rpc ?? createInternalRpc(env, fetcher);
    const call = (action: string, input: object) =>
      rpc("manage_stream_processing", {
        p_event_id: job.eventId,
        p_post_id: job.postId,
        p_job_id: job.jobId,
        p_action: action,
        p_input: input,
      });
    const claimed = await call("claim", {});
    if (claimed.code === "PREPARED") return "prepared";
    if (claimed.code === "STALE") return "stale";
    if (claimed.code !== "CLAIMED") return "retry";
    const plan = parsePlan(claimed.plan, job);
    if (
      !object(claimed.state) ||
      Object.keys(claimed.state).some((k) => !["source", "clip"].includes(k)) ||
      !Number.isSafeInteger(claimed.pollCount) ||
      Number(claimed.pollCount) < 0 ||
      Number(claimed.pollCount) > 60 ||
      !Number.isSafeInteger(claimed.deadline)
    )
      return "retry";
    const state = claimed.state;
    const providerGenerations = Object.entries(state).map(([name, value]) => {
      const parsed = parseOperation(value, name as "source" | "clip");
      const item = value as Record<string, unknown>;
      if (
        Number(item.providerPostVersion) > plan.scope.postVersion ||
        (item.providerPostVersion === plan.scope.postVersion &&
          item.providerJobId !== job.jobId)
      )
        return bad();
      return {
        operationId: parsed.operationId,
        jobId: item.providerJobId as string,
        postVersion: Number(item.providerPostVersion),
      };
    });
    const hold = async (errorCode: string): Promise<StreamRunnerResult> =>
      (await call("hold", { plan, errorCode })).code === "HELD"
        ? "held"
        : "retry";
    const wait = async (): Promise<StreamRunnerResult> => {
      const result = await call("poll", { plan });
      return result.code === "EXHAUSTED" ? hold("STREAM_TIMEOUT") : "retry";
    };
    if (
      Number(claimed.deadline) <= Date.now() ||
      Number(claimed.pollCount) >= 60
    )
      return hold("STREAM_TIMEOUT");
    const adapter =
      dependencies.adapter?.(plan, rpc) ??
      createStreamProcessingAdapter({
        enabled: true,
        accountId: env.R2_ACCOUNT_ID ?? "",
        originalsBucketName: "koko-dev-originals",
        originalReadAccessKeyId: env.KOKO_STREAM_R2_READ_ACCESS_KEY_ID ?? "",
        originalReadSecretAccessKey:
          env.KOKO_STREAM_R2_READ_SECRET_ACCESS_KEY ?? "",
        ...(env.ORIGINALS_BUCKET ? { originals: env.ORIGINALS_BUCKET } : {}),
        customerHost: env.KOKO_STREAM_CUSTOMER_HOST ?? "",
        allowedOrigins: [playbackHost(env.KOKO_STREAM_PLAYBACK_ORIGIN)],
        providerGenerations,
        apiToken: async () => env.KOKO_STREAM_API_TOKEN ?? "",
        isCurrent: async (scope, action, signal) => {
          if (
            Object.keys(scope).length !== Object.keys(plan.scope).length ||
            Object.entries(plan.scope).some(
              ([key, value]) => scope[key as keyof StreamScope] !== value,
            )
          )
            return false;
          return (
            (
              await rpc(
                "manage_stream_processing",
                {
                  p_event_id: job.eventId,
                  p_post_id: job.postId,
                  p_job_id: job.jobId,
                  p_action: "check",
                  p_input: { plan, action },
                },
                signal,
              )
            ).code === "CURRENT"
          );
        },
        fetcher,
      });
    if (!adapter) return "retry";
    const process = async (
      operation: "source" | "clip",
      source?: StreamReference,
    ): Promise<StreamObservation | null> => {
      let reserved: boolean, ref: Operation;
      if (state[operation]) {
        reserved = false;
        ref = parseOperation(state[operation], operation);
      } else {
        const result = await call("reserve", { plan, operation });
        if (!["RESERVED", "EXISTING"].includes(result.code as string))
          throw new Error();
        reserved = result.code === "RESERVED";
        ref = parseOperation(result.operation, operation);
      }
      if (operation === "clip" && ref.sourceUid !== source?.uid)
        throw new Error();
      let observation: StreamObservation;
      if (ref.uid !== null)
        observation = await adapter.inspect(plan.scope, ref as StreamReference);
      else if (!reserved) {
        const found = await adapter.reconcile(
          plan.scope,
          ref.operationId,
          ref.sourceUid,
        );
        if (found.state !== "found") return null;
        observation = found.video;
      } else if (operation === "source") {
        // Verify immutable object generation as well as the adapter's size/etag HEAD.
        if (!dependencies.adapter) {
          const key = `events/${job.eventId}/posts/${job.postId}/original/${plan.scope.assetId}.bin`;
          const head = await originalHead(env.ORIGINALS_BUCKET, key);
          if (
            !head ||
            head.key !== key ||
            head.version !== plan.original.objectVersion ||
            head.etag !== plan.original.etag ||
            head.size !== plan.original.size
          )
            throw new Error();
        }
        observation = await adapter.copy(plan.scope, ref.operationId, {
          size: plan.original.size,
          etag: plan.original.etag,
        });
      } else
        observation = await adapter.clip(
          plan.scope,
          ref.operationId,
          source!,
          3.8,
        );
      const result = await call("observe", { plan, operation, observation });
      if (result.code !== "OBSERVED") throw new Error();
      return observation;
    };
    try {
      const source = await process("source");
      if (!source) return wait();
      if (source.state === "error") return hold("STREAM_PROCESSING_FAILED");
      if (
        !source.processingComplete ||
        !source.readyToStream ||
        source.state !== "ready"
      )
        return wait();
      const video =
        plan.originalScope === "full_video_fallback"
          ? await process("clip", source.reference)
          : source;
      if (!video) return wait();
      if (video.state === "error") return hold("STREAM_PROCESSING_FAILED");
      if (
        !video.processingComplete ||
        !video.readyToStream ||
        video.state !== "ready"
      )
        return wait();
      if (!video.measuredDurationSeconds || video.measuredDurationSeconds > 4)
        return hold("VIDEO_TOO_LONG");
      return (await call("finish", { plan })).code === "PREPARED"
        ? "prepared"
        : "retry";
    } catch (error) {
      if (error instanceof StreamProcessingError && error.code === "STALE")
        return "stale";
      // All ambiguous/time-limited creations keep their reservation for read-only reconciliation.
      return wait();
    }
  } catch {
    return "retry";
  }
}
