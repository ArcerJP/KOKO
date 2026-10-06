import { originalKey, type ApiErrorCode } from "@koko/contract";
import { object, readApiSettings, uuid } from "./api-context";
import {
  completionErrors,
  completionReceipt,
  preparedCompletion,
} from "./completion-result";
import { CompletionError, verifyCompletedOriginal } from "./r2-completion";
import { type OriginalIdentity } from "./r2-upload";
import { type CompletionEnv } from "./upload-completion";

export type RecoveryEnv = CompletionEnv & {
  KOKO_EVENT_ID?: string;
  KOKO_UPLOAD_RECOVERY_ENABLED?: string;
  KOKO_UPLOAD_RECOVERY_QUEUE?: string;
  R2_ACCOUNT_ID?: string;
};
export const recoveryCron = "*/5 * * * *";
const maxCandidates = 10;
type Outcome = "accepted" | "ignored" | "deferred" | "retry";
const summary = () => ({ accepted: 0, ignored: 0, deferred: 0, retry: 0 });
const enabled = (env: RecoveryEnv) =>
  env.KOKO_UPLOADS_ENABLED === "true" &&
  env.KOKO_UPLOAD_RECOVERY_ENABLED === "true";

function recoveryEvent(env: RecoveryEnv): string {
  const eventId = env.KOKO_EVENT_ID;
  if (
    typeof eventId !== "string" ||
    eventId.length !== 36 ||
    !uuid.test(eventId) ||
    eventId !== eventId.toLowerCase()
  )
    throw new Error("UPLOAD_RECOVERY_CONFIGURATION_INVALID");
  return eventId;
}

/** Hints only: no owner, size, ETag, URL or manifest from the producer is trusted. */
function notification(body: unknown, account: string): OriginalIdentity | null {
  if (
    !object(body) ||
    body.account !== account ||
    body.bucket !== "koko-dev-originals" ||
    !["PutObject", "CompleteMultipartUpload"].includes(body.action as string) ||
    !object(body.object) ||
    typeof body.object.key !== "string"
  )
    return null;
  const match =
    /^events\/([^/]+)\/posts\/([^/]+)\/original\/([^/]+)\.bin$/.exec(
      body.object.key,
    );
  const eventId = match?.[1],
    postId = match?.[2],
    assetId = match?.[3];
  if (
    !eventId ||
    !postId ||
    !assetId ||
    [eventId, postId, assetId].some(
      (id) => id.length !== 36 || !uuid.test(id) || id !== id.toLowerCase(),
    ) ||
    body.object.key !== originalKey(eventId, postId, assetId)
  )
    return null;
  return { eventId, postId, assetId };
}

function recoveryClient(env: RecoveryEnv, fetcher: typeof fetch) {
  const settings = readApiSettings(env);
  if (
    !settings ||
    !env.ORIGINALS_BUCKET ||
    typeof env.ORIGINALS_BUCKET.head !== "function"
  )
    throw new Error("UPLOAD_RECOVERY_CONFIGURATION_INVALID");
  return async (
    name: "recover_upload" | "claim_upload_recovery",
    input: object,
  ): Promise<unknown> => {
    try {
      const response = await fetcher(
        new URL(`/rest/v1/rpc/${name}`, settings.url),
        {
          method: "POST",
          redirect: "manual",
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
          headers: {
            apikey: settings.secretKey,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) throw new CompletionError("INTERNAL_ERROR");
      const result: unknown = await response.json();
      if (
        object(result) &&
        completionErrors.includes(result.code as ApiErrorCode)
      )
        throw new CompletionError(result.code as ApiErrorCode);
      return result;
    } catch (error) {
      throw error instanceof CompletionError
        ? error
        : new CompletionError("INTERNAL_ERROR");
    }
  };
}

async function recover(
  identity: OriginalIdentity,
  env: RecoveryEnv,
  rpc: ReturnType<typeof recoveryClient>,
): Promise<Outcome> {
  try {
    const call = (action: "prepare" | "commit", input: object) =>
      rpc("recover_upload", {
        p_event_id: identity.eventId,
        p_post_id: identity.postId,
        p_asset_id: identity.assetId,
        p_action: action,
        p_input: input,
      });
    const result = await call("prepare", {});
    if (completionReceipt(result, identity.eventId, identity.postId))
      return "accepted";
    const prepared = preparedCompletion(result, identity);
    const observation = await verifyCompletedOriginal(
      env.ORIGINALS_BUCKET,
      prepared.identity,
      prepared.size,
      prepared.providerId,
      prepared.parts,
      "head-only",
    );
    const committed = await call("commit", {
      post_version: prepared.version,
      observation,
    });
    if (!completionReceipt(committed, identity.eventId, identity.postId))
      throw new CompletionError("INTERNAL_ERROR");
    return "accepted";
  } catch (error) {
    if (!(error instanceof CompletionError)) return "retry";
    if (error.code === "NOT_FOUND") return "ignored";
    if (
      [
        "FORBIDDEN",
        "CONSENT_REQUIRED",
        "ACCOUNT_BANNED",
        "EVENT_CLOSED",
        "PUBLICATION_STOPPED",
        "THEME_UNAVAILABLE",
        "STATE_CONFLICT",
        "IDEMPOTENCY_CONFLICT",
      ].includes(error.code)
    )
      return "deferred";
    return "retry";
  }
}

export async function handleUploadRecoveryQueue(
  batch: MessageBatch<unknown>,
  env: RecoveryEnv,
  fetcher: typeof fetch = fetch,
) {
  // Resolving a Queue invocation implicitly ACKs the batch. Fail closed instead.
  if (
    !enabled(env) ||
    !env.KOKO_UPLOAD_RECOVERY_QUEUE ||
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(env.KOKO_UPLOAD_RECOVERY_QUEUE) ||
    batch.queue !== env.KOKO_UPLOAD_RECOVERY_QUEUE ||
    !/^[a-f0-9]{32}$/.test(env.R2_ACCOUNT_ID ?? "") ||
    batch.messages.length > maxCandidates
  )
    throw new Error("UPLOAD_RECOVERY_QUEUE_NOT_READY");
  const eventId = recoveryEvent(env);
  const rpc = recoveryClient(env, fetcher);
  const counts = summary();
  for (const message of batch.messages) {
    const identity = notification(message.body, env.R2_ACCOUNT_ID!);
    const outcome =
      identity?.eventId === eventId
        ? await recover(identity, env, rpc)
        : "ignored";
    counts[outcome]++;
    if (outcome === "retry") message.retry({ delaySeconds: 60 });
    else message.ack();
  }
  return counts;
}

export async function handleUploadRecoveryScheduled(
  controller: Pick<ScheduledController, "cron">,
  env: RecoveryEnv,
  fetcher: typeof fetch = fetch,
) {
  if (!enabled(env)) return null;
  if (controller.cron !== recoveryCron)
    throw new Error("UPLOAD_RECOVERY_CRON_NOT_READY");
  const eventId = recoveryEvent(env);
  const rpc = recoveryClient(env, fetcher);
  const result = await rpc("claim_upload_recovery", {
    p_event_id: eventId,
    p_limit: maxCandidates,
  });
  if (
    !object(result) ||
    result.code !== "candidates" ||
    !Array.isArray(result.items) ||
    result.items.length > maxCandidates
  )
    throw new Error("UPLOAD_RECOVERY_CANDIDATES_INVALID");
  // Validate the whole response before any HEAD/commit; no arbitrary RPC target.
  const seen = new Set<string>();
  const candidates: OriginalIdentity[] = result.items.map((item: unknown) => {
    if (
      !object(item) ||
      Object.keys(item).length !== 3 ||
      typeof item.event_id !== "string" ||
      typeof item.post_id !== "string" ||
      typeof item.asset_id !== "string" ||
      item.event_id !== eventId ||
      [item.event_id, item.post_id, item.asset_id].some(
        (id) => id.length !== 36 || !uuid.test(id) || id !== id.toLowerCase(),
      )
    )
      throw new Error("UPLOAD_RECOVERY_CANDIDATES_INVALID");
    const key = `${item.event_id}/${item.post_id}/${item.asset_id}`;
    if (seen.has(key)) throw new Error("UPLOAD_RECOVERY_CANDIDATES_INVALID");
    seen.add(key);
    return {
      eventId: item.event_id,
      postId: item.post_id,
      assetId: item.asset_id,
    };
  });
  const counts = summary();
  for (const candidate of candidates)
    counts[await recover(candidate, env, rpc)]++;
  return counts;
}
