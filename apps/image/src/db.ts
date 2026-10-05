import {
  snapshotImageProcessingPlan,
  type ImageProcessingPlan,
  type ImageProcessingResult,
} from "./pipeline.js";
import { maxDerivativeBytes } from "./r2.js";

export type ImageJobReference = Readonly<{
  eventId: string;
  postId: string;
  jobId: string;
}>;
type Saved = Extract<ImageProcessingResult, { ok: true }>;
export type ImageReceipt = Pick<Saved, "originalSha256" | "deliveries">;
type ClaimCode =
  | "BUSY"
  | "EXHAUSTED"
  | "STALE"
  | "RESOURCE_LIMIT"
  | "INVALID_INPUT"
  | "IMAGE_SAVED";
type FinishCode =
  "RECORDED" | "STALE" | "CONFLICT" | "INVALID_INPUT" | "RESOURCE_LIMIT";
export type ImageDatabase = {
  claim(
    job: ImageJobReference,
  ): Promise<
    { code: "CLAIMED"; plan: ImageProcessingPlan } | { code: ClaimCode }
  >;
  check(plan: ImageProcessingPlan): Promise<boolean>;
  finish(
    plan: ImageProcessingPlan,
    receipt: ImageReceipt,
  ): Promise<{ code: FinishCode }>;
};
export class ImageDatabaseError extends Error {
  constructor(
    readonly code:
      "INVALID_DB_CONFIG" | "INVALID_INPUT" | "DB_FAILED" | "DB_TIMEOUT",
  ) {
    super(code);
    this.name = "ImageDatabaseError";
  }
}
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const exact = (x: object, names: string[]) =>
  Object.keys(x).length === names.length &&
  names.every((n) => Object.hasOwn(x, n));
const id = (x: unknown): x is string =>
  typeof x === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    x,
  );
const integer = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const sha = (x: unknown): x is string =>
  typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
function invalid(): never {
  throw new ImageDatabaseError("INVALID_INPUT");
}
function failed(): never {
  throw new ImageDatabaseError("DB_FAILED");
}
function job(value: ImageJobReference): ImageJobReference {
  if (
    !record(value) ||
    !exact(value, ["eventId", "postId", "jobId"]) ||
    !id(value.eventId) ||
    !id(value.postId) ||
    !id(value.jobId)
  )
    invalid();
  return Object.freeze({
    eventId: value.eventId,
    postId: value.postId,
    jobId: value.jobId,
  });
}
function plan(value: ImageProcessingPlan): ImageProcessingPlan {
  try {
    const p = snapshotImageProcessingPlan(value);
    if (p.postVersion > 2147483647) invalid();
    return p;
  } catch {
    return invalid();
  }
}
function receipt(value: ImageReceipt, p: ImageProcessingPlan): ImageReceipt {
  let copy: unknown;
  try {
    copy = structuredClone(value);
  } catch {
    return invalid();
  }
  if (
    !record(copy) ||
    !exact(copy, ["originalSha256", "deliveries"]) ||
    !sha(copy.originalSha256) ||
    (p.original.sha256 !== undefined &&
      p.original.sha256 !== copy.originalSha256) ||
    !Array.isArray(copy.deliveries) ||
    copy.deliveries.length !== 4
  )
    invalid();
  const seen = new Set<string>();
  for (const d of copy.deliveries as unknown[]) {
    if (
      !record(d) ||
      !exact(d, [
        "eventId",
        "assetId",
        "variant",
        "format",
        "outcome",
        "sha256",
        "size",
        "width",
        "height",
      ]) ||
      !id(d.assetId) ||
      seen.has(d.assetId) ||
      !sha(d.sha256) ||
      !["stored", "already_stored"].includes(d.outcome as string) ||
      !integer(d.size) ||
      d.size > maxDerivativeBytes ||
      !integer(d.width) ||
      !integer(d.height) ||
      !p.deliveries.some(
        (ref) =>
          ref.eventId === d.eventId &&
          ref.assetId === d.assetId &&
          ref.variant === d.variant &&
          ref.format === d.format,
      ) ||
      Math.max(d.width, d.height) > Number(d.variant)
    )
      invalid();
    seen.add(d.assetId);
  }
  return copy as ImageReceipt;
}

/** Trusted server-only configuration; no env read, login, HTTP route or retries. */
export function createImageDatabase(
  options: {
    enabled?: boolean;
    supabaseUrl?: string;
    secretKey?: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): ImageDatabase | null {
  if (options.enabled !== true) return null;
  const { supabaseUrl, secretKey, fetcher = fetch, timeoutMs = 5000 } = options;
  // A configured origin, never an incoming URL, path, host header or Queue field.
  if (
    typeof supabaseUrl !== "string" ||
    !/^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/.test(supabaseUrl) ||
    typeof secretKey !== "string" ||
    !/^sb_secret_[A-Za-z0-9_-]{1,256}$/.test(secretKey) ||
    typeof fetcher !== "function" ||
    !integer(timeoutMs) ||
    timeoutMs > 5000
  )
    throw new ImageDatabaseError("INVALID_DB_CONFIG");
  const endpoint = new URL("/rest/v1/rpc/manage_image_processing", supabaseUrl)
    .href;

  async function rpc(
    ref: ImageJobReference,
    action: "claim" | "check" | "finish",
    input: object,
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify({
      p_event_id: ref.eventId,
      p_post_id: ref.postId,
      p_job_id: ref.jobId,
      p_action: action,
      p_input: input,
    });
    if (Buffer.byteLength(body) > 16384) invalid();
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
              apikey: secretKey!,
              "content-type": "application/json",
              accept: "application/json",
            },
            body,
          });
          if (controller.signal.aborted) {
            void response.body?.cancel().catch(() => {});
            failed();
          }
          reader = response.body?.getReader();
          const length = response.headers.get("content-length");
          if (
            response.status !== 200 ||
            response.redirected ||
            (response.url && response.url !== endpoint) ||
            !/^application\/json(?:\s*;|$)/i.test(
              response.headers.get("content-type") ?? "",
            ) ||
            !reader ||
            (length !== null &&
              (!/^\d+$/.test(length) || Number(length) > 16384))
          )
            failed();
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const next = await reader.read();
            if (controller.signal.aborted) failed();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 16384) failed();
            chunks.push(next.value);
          }
          if (length !== null && Number(length) !== size) failed();
          return JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          ) as unknown;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ImageDatabaseError("DB_TIMEOUT"));
            controller.abort();
          }, timeoutMs);
        }),
      ]);
      if (!record(result)) failed();
      return result;
    } catch (error) {
      if (error instanceof ImageDatabaseError) throw error;
      return failed();
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  }
  const refFor = (p: ImageProcessingPlan): ImageJobReference => ({
    eventId: p.original.eventId,
    postId: p.original.postId,
    jobId: p.jobId,
  });
  return Object.freeze({
    async claim(value: ImageJobReference) {
      const ref = job(value);
      const r = await rpc(ref, "claim", {});
      if (r.code === "CLAIMED") {
        if (!exact(r, ["code", "plan"])) failed();
        let p: ImageProcessingPlan;
        try {
          p = plan(r.plan as ImageProcessingPlan);
        } catch {
          return failed();
        }
        if (
          p.jobId !== ref.jobId ||
          p.original.eventId !== ref.eventId ||
          p.original.postId !== ref.postId ||
          p.expiresAt <= Date.now() ||
          p.expiresAt > Date.now() + 125000
        )
          failed();
        return { code: "CLAIMED" as const, plan: p };
      }
      if (
        !exact(r, ["code"]) ||
        ![
          "BUSY",
          "EXHAUSTED",
          "STALE",
          "RESOURCE_LIMIT",
          "INVALID_INPUT",
          "IMAGE_SAVED",
        ].includes(r.code as string)
      )
        failed();
      return { code: r.code as ClaimCode };
    },
    async check(value: ImageProcessingPlan) {
      const p = plan(value);
      if (p.expiresAt <= Date.now()) return false;
      const r = await rpc(refFor(p), "check", { plan: p });
      if (
        !exact(r, ["code"]) ||
        !["CURRENT", "STALE", "RESOURCE_LIMIT", "INVALID_INPUT"].includes(
          r.code as string,
        )
      )
        failed();
      return r.code === "CURRENT" && p.expiresAt > Date.now();
    },
    async finish(value: ImageProcessingPlan, saved: ImageReceipt) {
      const p = plan(value);
      const proof = receipt(saved, p);
      // Expired plans are allowed here solely for DB-verified, already-recorded replay.
      const r = await rpc(refFor(p), "finish", { plan: p, ...proof });
      if (
        !exact(r, ["code"]) ||
        ![
          "RECORDED",
          "STALE",
          "CONFLICT",
          "INVALID_INPUT",
          "RESOURCE_LIMIT",
        ].includes(r.code as string)
      )
        failed();
      return { code: r.code as FinishCode };
    },
  });
}
