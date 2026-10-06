import { object, uuid } from "./api-context";

export type DeletionPlan = {
  event_id: string;
  post_id: string;
  asset_id: string;
  provider: "r2_original" | "r2_delivery" | "stream";
  purpose: string;
  mode: "delete" | "abort_multipart";
  object_key: string | null;
  stream_uid: string | null;
  size: number | null;
  etag: string | null;
  object_version: string | null;
  sha256: string | null;
  upload_id: string | null;
  policy: Record<string, unknown>;
  stream: {
    operation_id: string;
    job_id: string;
    post_version: number;
    original_asset_id: string;
    source_uid: string | null;
  } | null;
};
type Bucket = Pick<R2Bucket, "head" | "delete" | "resumeMultipartUpload">;
export type DeletionProviderEnv = {
  R2_ACCOUNT_ID?: string;
  KOKO_DELETION_API_TOKEN?: string;
  ORIGINALS_BUCKET?: Bucket;
  DERIVED_BUCKET?: Bucket;
};
export type DeletionResult =
  "ABSENT" | "LOCKED" | "IDENTITY_MISMATCH" | "AMBIGUOUS";
const id = (v: unknown): v is string =>
  typeof v === "string" && uuid.test(v) && v === v.toLowerCase();
const uid = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{32}$/.test(v);
const exact = (v: object, keys: string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** Reconstruct only repository-owned keys; service results are not arbitrary proxy input. */
export function readDeletionPlan(v: unknown): DeletionPlan | null {
  if (
    !object(v) ||
    !exact(v, [
      "event_id",
      "post_id",
      "asset_id",
      "provider",
      "purpose",
      "mode",
      "object_key",
      "stream_uid",
      "size",
      "etag",
      "object_version",
      "sha256",
      "upload_id",
      "policy",
      "stream",
    ]) ||
    !id(v.event_id) ||
    !id(v.post_id) ||
    !id(v.asset_id) ||
    !object(v.policy) ||
    !["delete", "abort_multipart"].includes(v.mode as string)
  )
    return null;
  if (v.provider === "stream") {
    const s = v.stream;
    if (
      v.mode !== "delete" ||
      !["stream_source", "stream_clip"].includes(v.purpose as string) ||
      !uid(v.stream_uid) ||
      v.object_key !== null ||
      v.upload_id !== null ||
      !object(s) ||
      !exact(s, [
        "operation_id",
        "job_id",
        "post_version",
        "original_asset_id",
        "source_uid",
      ]) ||
      !id(s.operation_id) ||
      !id(s.job_id) ||
      !id(s.original_asset_id) ||
      !positive(s.post_version) ||
      s.post_version > 2147483647 ||
      (v.purpose === "stream_source"
        ? s.source_uid !== null
        : !uid(s.source_uid) || s.source_uid === v.stream_uid)
    )
      return null;
  } else {
    if (v.stream !== null || v.stream_uid !== null) return null;
    if (v.provider === "r2_original") {
      if (
        v.purpose !== "original" ||
        v.object_key !==
          `events/${v.event_id}/posts/${v.post_id}/original/${v.asset_id}.bin`
      )
        return null;
      if (v.mode === "abort_multipart") {
        if (
          typeof v.upload_id !== "string" ||
          !/^[A-Za-z0-9_+/.=-]{1,1024}$/.test(v.upload_id) ||
          v.etag !== null ||
          v.object_version !== null
        )
          return null;
      } else if (
        v.upload_id !== null ||
        typeof v.etag !== "string" ||
        !/^[a-f0-9]{32}(?:-[1-9][0-9]{0,4})?$/.test(v.etag) ||
        typeof v.object_version !== "string" ||
        !/^[\x21-\x7e]{1,256}$/.test(v.object_version) ||
        !positive(v.size)
      )
        return null;
    } else if (v.provider === "r2_delivery") {
      const match = /^delivery_(600|1600)_(webp|jpg)$/.exec(String(v.purpose));
      if (
        !match ||
        v.mode !== "delete" ||
        v.upload_id !== null ||
        v.object_key !==
          `events/${v.event_id}/delivery/${v.asset_id}/${match[1]}.${match[2]}` ||
        !positive(v.size) ||
        typeof v.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(v.sha256)
      )
        return null;
    } else return null;
  }
  return v as DeletionPlan;
}

/** Unknown/invalid lock rules are never treated as unlocked. Longest matching lock wins. */
export function lockAllowsDeletion(
  value: unknown,
  key: string,
  uploaded: Date,
  now: number,
): boolean {
  if (
    !object(value) ||
    !Array.isArray(value.rules) ||
    value.rules.length > 1000 ||
    !Number.isFinite(uploaded.getTime()) ||
    uploaded.getTime() > now
  )
    return false;
  for (const rule of value.rules) {
    if (
      !object(rule) ||
      typeof rule.id !== "string" ||
      typeof rule.enabled !== "boolean" ||
      (rule.prefix !== undefined && typeof rule.prefix !== "string") ||
      !object(rule.condition)
    )
      return false;
    const condition = rule.condition;
    let until: number;
    if (condition.type === "Indefinite" && exact(condition, ["type"]))
      until = Infinity;
    else if (
      condition.type === "Age" &&
      exact(condition, ["type", "maxAgeSeconds"]) &&
      typeof condition.maxAgeSeconds === "number" &&
      Number.isSafeInteger(condition.maxAgeSeconds) &&
      condition.maxAgeSeconds >= 0 &&
      condition.maxAgeSeconds <= 3153600000
    )
      until = uploaded.getTime() + condition.maxAgeSeconds * 1000;
    else if (
      condition.type === "Date" &&
      exact(condition, ["type", "date"]) &&
      typeof condition.date === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(condition.date) &&
      Number.isFinite(Date.parse(condition.date))
    )
      until = Date.parse(condition.date);
    else return false;
    if (
      rule.enabled &&
      key.startsWith((rule.prefix as string | undefined) ?? "") &&
      now < until
    )
      return false;
  }
  return true;
}

export function deletionProviderConfigured(env: DeletionProviderEnv) {
  return (
    uid(env.R2_ACCOUNT_ID) &&
    typeof env.KOKO_DELETION_API_TOKEN === "string" &&
    /^[A-Za-z0-9_-]{20,256}$/.test(env.KOKO_DELETION_API_TOKEN)
  );
}

/** Fixed account/endpoint only. No caller URL, automatic retries, redirects or raw error logging. */
export async function deleteProviderAsset(
  plan: DeletionPlan,
  env: DeletionProviderEnv,
  recheck: () => Promise<boolean>,
  fetcher: typeof fetch = fetch,
): Promise<DeletionResult> {
  if (!readDeletionPlan(plan) || !deletionProviderConfigured(env))
    return "IDENTITY_MISMATCH";
  const abort = new AbortController();
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    abort.abort();
    for (const r of readers) void r.cancel().catch(() => {});
  };
  const current = async () => {
    abort.signal.throwIfAborted();
    if (!(await recheck())) throw new Error();
    abort.signal.throwIfAborted();
  };
  const api = async (path: string, method = "GET") => {
    abort.signal.throwIfAborted();
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${env.R2_ACCOUNT_ID}/${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${env.KOKO_DELETION_API_TOKEN}`,
          accept: "application/json",
        },
        redirect: "manual",
        cache: "no-store",
        signal: abort.signal,
      },
    );
    const reader = response.body?.getReader();
    if (reader) readers.add(reader);
    try {
      abort.signal.throwIfAborted();
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      )
        throw new Error();
      let text = "",
        size = 0;
      const decoder = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      });
      if (reader)
        for (;;) {
          const part = await reader.read();
          abort.signal.throwIfAborted();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 262144) throw new Error();
          text += decoder.decode(part.value, { stream: true });
        }
      text += decoder.decode();
      if (method === "DELETE") return { status: response.status, data: null };
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        throw new Error();
      const data: unknown = JSON.parse(text);
      if (!object(data)) throw new Error();
      return { status: response.status, data };
    } finally {
      if (reader) {
        void reader.cancel().catch(() => {});
        readers.delete(reader);
        reader.releaseLock();
      }
    }
  };
  const perform = async (): Promise<DeletionResult> => {
    await current();
    if (plan.provider === "stream") {
      const s = plan.stream!;
      const absent = async () => {
        const list = await api(
          `stream?video_name=${encodeURIComponent(`koko-${s.operation_id}`)}&limit=2`,
        );
        return (
          list.status === 200 &&
          list.data?.success === true &&
          Array.isArray(list.data.result) &&
          list.data.result.length === 0
        );
      };
      const read = await api(`stream/${plan.stream_uid}`);
      if (
        read.status === 404 &&
        read.data?.success === false &&
        (await absent())
      )
        return "ABSENT";
      const video = read.data?.result;
      const metadata = object(video) ? video.meta : null;
      const expected = {
        name: `koko-${s.operation_id}`,
        koko_event: plan.event_id,
        koko_post: plan.post_id,
        koko_asset: s.original_asset_id,
        koko_job: s.job_id,
        koko_version: String(s.post_version),
        koko_operation: s.operation_id,
        koko_source: s.source_uid ?? "original",
      };
      if (
        read.status !== 200 ||
        read.data?.success !== true ||
        !object(video) ||
        video.uid !== plan.stream_uid ||
        video.requireSignedURLs !== true ||
        (s.source_uid === null
          ? video.clippedFrom !== undefined &&
            video.clippedFrom !== null &&
            video.clippedFrom !== ""
          : video.clippedFrom !== s.source_uid) ||
        !object(metadata) ||
        Object.entries(expected).some(([k, v]) => metadata[k] !== v)
      )
        return "IDENTITY_MISMATCH";
      await current();
      const deleted = await api(`stream/${plan.stream_uid}`, "DELETE");
      if (![200, 204].includes(deleted.status)) return "AMBIGUOUS";
      const check = await api(`stream/${plan.stream_uid}`);
      return check.status === 404 &&
        check.data?.success === false &&
        (await absent())
        ? "ABSENT"
        : "AMBIGUOUS";
    }
    const bucket =
      plan.provider === "r2_original"
        ? env.ORIGINALS_BUCKET
        : env.DERIVED_BUCKET;
    if (!bucket) return "IDENTITY_MISMATCH";
    const key = plan.object_key!;
    let head = await bucket.head(key);
    abort.signal.throwIfAborted();
    if (plan.mode === "abort_multipart") {
      if (head !== null) return "IDENTITY_MISMATCH";
      await current();
      await bucket.resumeMultipartUpload(key, plan.upload_id!).abort();
      abort.signal.throwIfAborted();
      return (await bucket.head(key)) === null ? "ABSENT" : "IDENTITY_MISMATCH";
    }
    if (head === null) return "ABSENT";
    const same = (h: R2Object) =>
      h.key === key &&
      h.size === plan.size &&
      (plan.provider === "r2_original"
        ? h.etag === plan.etag && h.version === plan.object_version
        : h.customMetadata?.sha256 === plan.sha256);
    if (!same(head)) return "IDENTITY_MISMATCH";
    const lock = await api(
      `r2/buckets/${plan.provider === "r2_original" ? "koko-dev-originals" : "koko-dev-derived"}/lock`,
    );
    if (
      lock.status !== 200 ||
      lock.data?.success !== true ||
      !lockAllowsDeletion(lock.data.result, key, head.uploaded, Date.now())
    )
      return "LOCKED";
    // Worker delete has NO conditional-version option. DB write-quiescence proof is required;
    // the repeat HEAD detects drift, it is not represented as an atomic compare-and-delete.
    await current();
    const previous = head;
    head = await bucket.head(key);
    abort.signal.throwIfAborted();
    if (head === null) return "ABSENT";
    if (
      !same(head) ||
      head.version !== previous.version ||
      head.etag !== previous.etag
    )
      return "IDENTITY_MISMATCH";
    await bucket.delete(key);
    abort.signal.throwIfAborted();
    return (await bucket.head(key)) === null ? "ABSENT" : "AMBIGUOUS";
  };
  try {
    return await Promise.race([
      perform(),
      new Promise<DeletionResult>((resolve) => {
        timer = setTimeout(() => {
          stop();
          resolve("AMBIGUOUS");
        }, 60000);
      }),
    ]);
  } catch {
    return "AMBIGUOUS";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    stop();
  }
}
