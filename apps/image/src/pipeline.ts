import { createHash } from "node:crypto";
import { transformImage } from "./index.js";
import {
  ImageStorageError,
  maxDerivativeBytes,
  maxOriginalReadBytes,
  type createImageR2Store,
  type DeliveryReference,
  type OriginalReference,
} from "./r2.js";
import type { Derivative } from "./types.js";

/** Internal DB-verified plan, never a browser/Queue payload or authorization. */
export type ImageProcessingPlan = Readonly<{
  jobId: string;
  leaseId: string;
  postVersion: number;
  expiresAt: number;
  original: Readonly<OriginalReference>;
  deliveries: readonly Readonly<DeliveryReference>[];
}>;
type Store = NonNullable<ReturnType<typeof createImageR2Store>>;
type Failure =
  | "INVALID_PLAN"
  | "BUSY"
  | "STALE"
  | "CHECK_FAILED"
  | "CHECK_TIMEOUT"
  | "INVALID_DERIVATIVES"
  | "PIPELINE_FAILED"
  | "RESOURCE_LIMIT"
  | "ORIGINAL_MISMATCH"
  | "DELIVERY_CONFLICT"
  | "STORAGE_FAILED"
  | "TIMEOUT"
  | "DECODE_FAILED"
  | "WORKER_FAILED";
type Receipt = DeliveryReference & {
  outcome: "stored" | "already_stored";
  sha256: string;
  size: number;
  width: number;
  height: number;
};
export type ImageProcessingResult =
  | { ok: false; reason: Failure }
  | {
      ok: true;
      // Saved privately, NOT an atomic DB completion, moderation or publishing.
      outcome: "saved";
      originalSha256: string;
      ai: Derivative;
      deliveries: Receipt[];
    };
class PipelineError extends Error {
  constructor(readonly reason: Failure) {
    super(reason);
  }
}
function fail(reason: Failure): never {
  throw new PipelineError(reason);
}
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const keys = (x: object, allowed: string[]) =>
  Object.keys(x).every((k) => allowed.includes(k));
const id = (x: unknown): x is string =>
  typeof x === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    x,
  );
const integer = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const sha = (x: unknown): x is string =>
  typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const variants = ["600/webp", "600/jpg", "1600/webp", "1600/jpg"];

function snapshot(value: unknown): ImageProcessingPlan {
  let x: unknown;
  try {
    x = structuredClone(value);
  } catch {
    return fail("INVALID_PLAN");
  }
  if (
    !record(x) ||
    !keys(x, [
      "jobId",
      "leaseId",
      "postVersion",
      "expiresAt",
      "original",
      "deliveries",
    ]) ||
    !id(x.jobId) ||
    !id(x.leaseId) ||
    !integer(x.postVersion) ||
    !integer(x.expiresAt)
  )
    fail("INVALID_PLAN");
  const p = x as Record<string, unknown>;
  const o = p.original;
  if (
    !record(o) ||
    !keys(o, ["eventId", "postId", "assetId", "size", "etag", "sha256"]) ||
    !id(o.eventId) ||
    !id(o.postId) ||
    !id(o.assetId) ||
    !integer(o.size) ||
    typeof o.etag !== "string" ||
    !/^[a-f0-9]{32}(?:-[1-9][0-9]{0,3}|-10000)?$/.test(o.etag) ||
    (o.sha256 !== undefined && !sha(o.sha256))
  )
    fail("INVALID_PLAN");
  const original = o as OriginalReference;
  if (original.size > maxOriginalReadBytes) fail("RESOURCE_LIMIT");
  if (!Array.isArray(p.deliveries) || p.deliveries.length !== 4)
    fail("INVALID_PLAN");
  const deliveries = p.deliveries as unknown[];
  const ids = new Set([original.assetId]);
  const kinds = new Set<string>();
  for (const d of deliveries) {
    if (
      !record(d) ||
      !keys(d, ["eventId", "assetId", "variant", "format"]) ||
      d.eventId !== original.eventId ||
      !id(d.assetId) ||
      ids.has(d.assetId) ||
      !["600", "1600"].includes(d.variant as string) ||
      !["webp", "jpg"].includes(d.format as string)
    )
      fail("INVALID_PLAN");
    const ref = d as DeliveryReference;
    const kind = `${ref.variant}/${ref.format}`;
    if (kinds.has(kind)) fail("INVALID_PLAN");
    kinds.add(kind);
    ids.add(ref.assetId);
    Object.freeze(d);
  }
  Object.freeze(original);
  Object.freeze(deliveries);
  return Object.freeze(p) as ImageProcessingPlan;
}

function derivatives(value: unknown): Map<string, Derivative> {
  if (!Array.isArray(value) || value.length !== 5) fail("INVALID_DERIVATIVES");
  const result = new Map<string, Derivative>();
  for (const d of value as unknown[]) {
    if (
      !record(d) ||
      !keys(d, ["name", "contentType", "width", "height", "sha256", "bytes"]) ||
      typeof d.name !== "string" ||
      !integer(d.width) ||
      !integer(d.height) ||
      !sha(d.sha256) ||
      !(d.bytes instanceof Uint8Array) ||
      !integer(d.bytes.byteLength)
    )
      fail("INVALID_DERIVATIVES");
    const item = d as unknown as Derivative;
    const ai = item.name === "ai-1024.jpg";
    const match = /^display-(600|1600)\.(webp|jpg)$/.exec(item.name);
    if (
      (!ai && !match) ||
      result.has(item.name) ||
      item.contentType !==
        (item.name.endsWith(".jpg") ? "image/jpeg" : "image/webp") ||
      Math.max(item.width, item.height) > (ai ? 1024 : Number(match![1])) ||
      item.bytes.byteLength > maxDerivativeBytes
    )
      fail("INVALID_DERIVATIVES");
    const bytes = Buffer.from(item.bytes);
    if (hash(bytes) !== item.sha256) fail("INVALID_DERIVATIVES");
    result.set(item.name, { ...item, bytes });
  }
  if (
    !result.has("ai-1024.jpg") ||
    variants.some((v) => !result.has(`display-${v.replace("/", ".")}`))
  )
    fail("INVALID_DERIVATIVES");
  return result;
}

/**
 * Disabled unless explicitly constructed by trusted server code. No env read,
 * HTTP/Queue registration, DB mutation, publication, cleanup or automatic retry.
 * isCurrent MUST read the authoritative DB and validate this exact plan's job,
 * lease, version, owner, flags, BAN/deletion and reserved assets. Not a client bool.
 */
export function createImagePipeline(
  options: {
    enabled?: boolean;
    store?: Store | null;
    isCurrent?: (plan: ImageProcessingPlan) => Promise<boolean>;
    transform?: typeof transformImage;
    checkTimeoutMs?: number;
  } = {},
): {
  process(plan: ImageProcessingPlan): Promise<ImageProcessingResult>;
} | null {
  if (options.enabled !== true) return null;
  const {
    store,
    isCurrent,
    transform = transformImage,
    checkTimeoutMs = 5_000,
  } = options;
  if (
    !store ||
    typeof store.getOriginal !== "function" ||
    typeof store.putDelivery !== "function" ||
    typeof isCurrent !== "function" ||
    typeof transform !== "function" ||
    !integer(checkTimeoutMs) ||
    checkTimeoutMs > 5_000
  )
    throw new Error("INVALID_PIPELINE_CONFIG");
  const getOriginal = store.getOriginal.bind(store);
  const putDelivery = store.putDelivery.bind(store);
  let active = false;
  async function check(plan: ImageProcessingPlan) {
    if (Date.now() >= plan.expiresAt) fail("STALE");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const allowed = await Promise.race([
        Promise.resolve().then(() => isCurrent!(plan)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new PipelineError("CHECK_TIMEOUT")),
            checkTimeoutMs,
          );
        }),
      ]);
      if (allowed !== true || Date.now() >= plan.expiresAt) fail("STALE");
    } catch (error) {
      if (error instanceof PipelineError) throw error;
      fail("CHECK_FAILED");
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async process(input) {
      if (active) return { ok: false, reason: "BUSY" };
      active = true;
      try {
        const plan = snapshot(input);
        await check(plan);
        const source = await getOriginal(plan.original);
        const bytes = Buffer.from(source.bytes);
        const originalSha256 = hash(bytes);
        if (
          bytes.length !== plan.original.size ||
          originalSha256 !== source.sha256 ||
          (plan.original.sha256 !== undefined &&
            originalSha256 !== plan.original.sha256)
        )
          fail("ORIGINAL_MISMATCH");
        await check(plan);
        const converted = await transform(bytes);
        if (hash(bytes) !== originalSha256) fail("ORIGINAL_MISMATCH");
        if (!converted.ok) {
          const reason = converted.reason;
          if (
            reason === "BUSY" ||
            reason === "TIMEOUT" ||
            reason === "DECODE_FAILED" ||
            reason === "WORKER_FAILED"
          )
            fail(reason);
          fail("INVALID_DERIVATIVES");
        }
        // Inspect ALL outputs before the first PUT; snapshot across later awaits.
        const outputs = derivatives(converted.derivatives);
        const receipts: Receipt[] = [];
        for (const ref of plan.deliveries) {
          await check(plan);
          const value = outputs.get(`display-${ref.variant}.${ref.format}`)!;
          const receipt = await putDelivery(ref, {
            ...value,
            bytes: Buffer.from(value.bytes),
          });
          if (
            !receipt ||
            !["stored", "already_stored"].includes(receipt.outcome) ||
            receipt.size !== value.bytes.length ||
            receipt.sha256 !== value.sha256
          )
            fail("STORAGE_FAILED");
          receipts.push({
            ...ref,
            outcome: receipt.outcome,
            sha256: receipt.sha256,
            size: receipt.size,
            width: value.width,
            height: value.height,
          });
        }
        await check(plan);
        return {
          ok: true,
          outcome: "saved",
          originalSha256,
          ai: outputs.get("ai-1024.jpg")!,
          deliveries: receipts,
        };
      } catch (error) {
        if (error instanceof PipelineError)
          return { ok: false, reason: error.reason };
        if (error instanceof ImageStorageError) {
          const reason = error.code;
          if (
            reason === "RESOURCE_LIMIT" ||
            reason === "ORIGINAL_MISMATCH" ||
            reason === "DELIVERY_CONFLICT" ||
            reason === "STORAGE_FAILED" ||
            reason === "TIMEOUT"
          )
            return { ok: false, reason };
        }
        return { ok: false, reason: "PIPELINE_FAILED" };
      } finally {
        active = false;
      }
    },
  };
}
