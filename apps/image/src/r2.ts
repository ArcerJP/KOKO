import { createHash } from "node:crypto";
import { deliveryKey, originalKey } from "@koko/contract";
import { AwsClient } from "aws4fetch";
import type { Derivative } from "./types.js";

// Execution budgets for the buffer-based adapter, NOT product upload limits.
export const maxOriginalReadBytes = 64 * 1024 ** 2;
export const maxDerivativeBytes = 16 * 1024 ** 2;
export type ImageR2Env = {
  KOKO_IMAGE_R2_ENABLED?: string;
  R2_ACCOUNT_ID?: string;
  R2_ORIGINAL_READ_ACCESS_KEY_ID?: string;
  R2_ORIGINAL_READ_SECRET_ACCESS_KEY?: string;
  R2_DERIVED_ACCESS_KEY_ID?: string;
  R2_DERIVED_SECRET_ACCESS_KEY?: string;
};
export type OriginalReference = {
  eventId: string;
  postId: string;
  assetId: string;
  size: number;
  etag: string;
  sha256?: string;
};
export type DeliveryReference = {
  eventId: string;
  assetId: string;
  variant: "600" | "1600";
  format: "webp" | "jpg";
};
type Failure =
  | "INVALID_CONFIG"
  | "INVALID_INPUT"
  | "RESOURCE_LIMIT"
  | "ORIGINAL_MISMATCH"
  | "DELIVERY_CONFLICT"
  | "STORAGE_FAILED"
  | "TIMEOUT";
export class ImageStorageError extends Error {
  constructor(readonly code: Failure) {
    super(code);
    this.name = "ImageStorageError";
  }
}
function fail(code: Failure): never {
  throw new ImageStorageError(code);
}
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: object, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
const size = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const id = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    v,
  );
const sha = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

function original(ref: OriginalReference) {
  if (
    !record(ref) ||
    !keys(ref, ["eventId", "postId", "assetId", "size", "etag", "sha256"]) ||
    !id(ref.eventId) ||
    !id(ref.postId) ||
    !id(ref.assetId) ||
    !size(ref.size) ||
    typeof ref.etag !== "string" ||
    !/^[a-f0-9]{32}(?:-[1-9][0-9]{0,3}|-10000)?$/.test(ref.etag) ||
    (ref.sha256 !== undefined && !sha(ref.sha256))
  )
    fail("INVALID_INPUT");
  if (ref.size > maxOriginalReadBytes) fail("RESOURCE_LIMIT");
  return { ...ref, key: originalKey(ref.eventId, ref.postId, ref.assetId) };
}

function delivery(ref: DeliveryReference, value: Derivative) {
  if (
    !record(ref) ||
    !keys(ref, ["eventId", "assetId", "variant", "format"]) ||
    !id(ref.eventId) ||
    !id(ref.assetId) ||
    !["600", "1600"].includes(ref.variant) ||
    !["webp", "jpg"].includes(ref.format) ||
    !record(value) ||
    !keys(value, [
      "name",
      "contentType",
      "width",
      "height",
      "sha256",
      "bytes",
    ]) ||
    value.name !== `display-${ref.variant}.${ref.format}` ||
    value.contentType !==
      (ref.format === "jpg" ? "image/jpeg" : "image/webp") ||
    !size(value.width) ||
    !size(value.height) ||
    Math.max(value.width, value.height) > Number(ref.variant) ||
    !sha(value.sha256) ||
    !(value.bytes instanceof Uint8Array) ||
    !size(value.bytes.byteLength)
  )
    fail("INVALID_INPUT");
  if (value.bytes.byteLength > maxDerivativeBytes) fail("RESOURCE_LIMIT");
  // Snapshot before the first await: caller mutation must not change signed bytes.
  const bytes = Buffer.from(value.bytes);
  if (hash(bytes) !== value.sha256) fail("INVALID_INPUT");
  return {
    key: deliveryKey(ref.eventId, ref.assetId, ref.variant, ref.format),
    bytes,
    sha256: value.sha256,
    contentType: value.contentType,
    md5: createHash("md5").update(bytes).digest(),
  };
}

/**
 * Internal, development-only adapter. NOT authentication or a job consumer.
 * Call only after DB job/lease/post/version/asset checks. Never expose results
 * directly to browsers. No original write, AI persistence, list or delete API.
 */
export function createImageR2Store(
  env: ImageR2Env,
  fetcher: typeof fetch = fetch,
  timeoutMs = 15_000,
) {
  if (env.KOKO_IMAGE_R2_ENABLED !== "true") return null;
  const hex = (value: unknown, count: number): value is string =>
    typeof value === "string" && new RegExp(`^[0-9a-f]{${count}}$`).test(value);
  if (
    !hex(env.R2_ACCOUNT_ID, 32) ||
    !hex(env.R2_ORIGINAL_READ_ACCESS_KEY_ID, 32) ||
    !hex(env.R2_ORIGINAL_READ_SECRET_ACCESS_KEY, 64) ||
    !hex(env.R2_DERIVED_ACCESS_KEY_ID, 32) ||
    !hex(env.R2_DERIVED_SECRET_ACCESS_KEY, 64) ||
    env.R2_ORIGINAL_READ_ACCESS_KEY_ID === env.R2_DERIVED_ACCESS_KEY_ID ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 15_000
  )
    fail("INVALID_CONFIG");
  const origin = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const signer = (accessKeyId: string, secretAccessKey: string) =>
    new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: "s3",
      region: "auto",
      retries: 0,
    });
  const readSigner = signer(
    env.R2_ORIGINAL_READ_ACCESS_KEY_ID,
    env.R2_ORIGINAL_READ_SECRET_ACCESS_KEY,
  );
  const derivedSigner = signer(
    env.R2_DERIVED_ACCESS_KEY_ID,
    env.R2_DERIVED_SECRET_ACCESS_KEY,
  );

  async function operation<T>(
    action: (io: {
      request: (
        client: AwsClient,
        bucket: string,
        key: string,
        init: RequestInit,
      ) => Promise<Response>;
      bytes: (
        response: Response,
        expected: number,
        mismatch: Failure,
      ) => Promise<Buffer>;
    }) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const bodies = new Set<ReadableStream<Uint8Array>>();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = () => {
      if (controller.signal.aborted) fail("TIMEOUT");
    };
    try {
      return await Promise.race([
        action({
          async request(client, bucket, key, init) {
            cancelled();
            const request = await client.sign(
              new URL(`/${bucket}/${key}`, origin),
              {
                ...init,
                signal: controller.signal,
                redirect: "manual",
                cache: "no-store",
                aws: { allHeaders: true },
              },
            );
            cancelled();
            const response = await fetcher(request);
            if (controller.signal.aborted) {
              void response.body?.cancel().catch(() => {});
              fail("TIMEOUT");
            }
            if (response.body) bodies.add(response.body);
            return response;
          },
          async bytes(response, expected, mismatch) {
            const encoding = response.headers.get("content-encoding");
            if (
              response.headers.get("content-length") !== String(expected) ||
              (encoding !== null && encoding !== "identity") ||
              !response.body
            )
              fail(mismatch);
            reader = response.body.getReader();
            const chunks: Buffer[] = [];
            let length = 0;
            while (true) {
              const chunk = await reader.read();
              cancelled();
              if (chunk.done) break;
              length += chunk.value.byteLength;
              if (length > expected) fail(mismatch);
              chunks.push(Buffer.from(chunk.value));
            }
            if (length !== expected) fail(mismatch);
            return Buffer.concat(chunks, length);
          },
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ImageStorageError("TIMEOUT"));
            controller.abort();
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      throw error instanceof ImageStorageError
        ? error
        : new ImageStorageError("STORAGE_FAILED");
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => {});
      for (const body of bodies)
        if (!body.locked) void body.cancel().catch(() => {});
    }
  }

  return {
    async getOriginal(reference: OriginalReference) {
      const ref = original(reference);
      return operation(async (io) => {
        const response = await io.request(
          readSigner,
          "koko-dev-originals",
          ref.key,
          {
            method: "GET",
            headers: {
              "if-match": `"${ref.etag}"`,
              "accept-encoding": "identity",
            },
          },
        );
        if ([404, 412].includes(response.status)) fail("ORIGINAL_MISMATCH");
        if (response.status !== 200) fail("STORAGE_FAILED");
        if (response.headers.get("etag") !== `"${ref.etag}"`)
          fail("ORIGINAL_MISMATCH");
        const bytes = await io.bytes(response, ref.size, "ORIGINAL_MISMATCH");
        const sha256 = hash(bytes);
        if (ref.sha256 !== undefined && ref.sha256 !== sha256)
          fail("ORIGINAL_MISMATCH");
        return { bytes, sha256 };
      });
    },
    async putDelivery(reference: DeliveryReference, derivative: Derivative) {
      const value = delivery(reference, derivative);
      const etag = `"${value.md5.toString("hex")}"`;
      return operation(async (io) => {
        const response = await io.request(
          derivedSigner,
          "koko-dev-derived",
          value.key,
          {
            method: "PUT",
            body: value.bytes,
            headers: {
              "if-none-match": "*",
              "content-type": value.contentType,
              "content-md5": value.md5.toString("base64"),
              "cache-control": "private, no-store",
              "x-amz-meta-sha256": value.sha256,
            },
          },
        );
        if (response.status === 200) {
          // Content-MD5 is transport integrity, not moderation or authorization.
          if (response.headers.get("etag") !== etag) fail("STORAGE_FAILED");
          return {
            outcome: "stored" as const,
            sha256: value.sha256,
            size: value.bytes.length,
          };
        }
        if (response.status !== 412) fail("STORAGE_FAILED");
        const existing = await io.request(
          derivedSigner,
          "koko-dev-derived",
          value.key,
          {
            method: "GET",
            headers: { "if-match": etag, "accept-encoding": "identity" },
          },
        );
        if ([404, 412].includes(existing.status)) fail("DELIVERY_CONFLICT");
        if (existing.status !== 200) fail("STORAGE_FAILED");
        const caching = (existing.headers.get("cache-control") ?? "")
          .toLowerCase()
          .split(",")
          .map((x) => x.trim());
        if (
          existing.headers.get("etag") !== etag ||
          existing.headers.get("content-type") !== value.contentType ||
          existing.headers.get("x-amz-meta-sha256") !== value.sha256 ||
          !caching.includes("private") ||
          !caching.includes("no-store")
        )
          fail("DELIVERY_CONFLICT");
        const bytes = await io.bytes(
          existing,
          value.bytes.length,
          "DELIVERY_CONFLICT",
        );
        if (hash(bytes) !== value.sha256) fail("DELIVERY_CONFLICT");
        return {
          outcome: "already_stored" as const,
          sha256: value.sha256,
          size: bytes.length,
        };
      });
    },
  };
}
