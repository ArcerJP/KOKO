import { originalKey } from "@koko/contract";
import { AwsClient } from "aws4fetch";

const MiB = 1024 ** 2;
export const maxR2ObjectBytes = 5 * 1024 ** 4 - 5 * 1024 ** 3;
export const singleUploadThresholdBytes = 64 * MiB;
export const maxUploadSignatureSeconds = 900;
// This adapter is development-only, matching wrangler.jsonc. No caller bucket/URL.
const originalsBucketName = "koko-dev-originals";

type UploadPlan =
  | { mode: "single" }
  | { mode: "multipart"; partSizeBytes: number; partCount: number };
export type OriginalIdentity = {
  eventId: string;
  postId: string;
  assetId: string;
};
export type R2SigningEnv = {
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
};
type OriginalBucket = Pick<
  R2Bucket,
  "createMultipartUpload" | "resumeMultipartUpload"
>;
type SignedSinglePut = {
  put_url: string;
  required_headers: Record<string, string>;
  expires_at: string;
};
type SignedPartPut = {
  part_number: number;
  put_url: string;
  expires_at: string;
};
type FailureCode = "INVALID_INPUT" | "PROVIDER_LIMIT" | "INTERNAL_ERROR";

/** Do not attach provider exceptions, signing inputs, URLs, or credentials. */
export class R2UploadError extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
    this.name = "R2UploadError";
  }
}

export function planR2Upload(sizeBytes: number): UploadPlan {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1)
    throw new R2UploadError("INVALID_INPUT");
  if (sizeBytes > maxR2ObjectBytes) throw new R2UploadError("PROVIDER_LIMIT");
  if (sizeBytes <= singleUploadThresholdBytes) return { mode: "single" };
  // 8 MiB baseline; scale in whole MiB to stay within 10,000 parts.
  const partSizeBytes = Math.max(8, Math.ceil(sizeBytes / 10000 / MiB)) * MiB;
  return {
    mode: "multipart",
    partSizeBytes,
    partCount: Math.ceil(sizeBytes / partSizeBytes),
  };
}

function keyFor(identity: OriginalIdentity): string {
  try {
    return originalKey(identity.eventId, identity.postId, identity.assetId);
  } catch {
    throw new R2UploadError("INVALID_INPUT");
  }
}

function contentType(value: string): string {
  // HTTP headers are byte strings. Do not silently normalize an initial declaration.
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    value.trim() !== value ||
    /[^\x20-\x7e]/.test(value)
  )
    throw new R2UploadError("INVALID_INPUT");
  return value;
}

function providerId(value: string): string {
  // Opaque provider data, not an application upload UUID. Encode it as ONE query value.
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,2048}$/.test(value))
    throw new R2UploadError("INVALID_INPUT");
  return value;
}

function signingWindow(expiresAt: string, now: number) {
  const end = Date.parse(expiresAt);
  const start = Math.floor(now / 1000) * 1000;
  const seconds = Math.floor((end - start) / 1000);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(end) ||
    end <= now ||
    seconds < 1 ||
    seconds > maxUploadSignatureSeconds
  )
    throw new R2UploadError("INVALID_INPUT");
  return {
    datetime: new Date(start).toISOString().replace(/[:-]|\.000/g, ""),
    seconds,
    expiresAt: new Date(start + seconds * 1000).toISOString(),
  };
}

/**
 * Internal provider adapter, NOT authorization or an HTTP endpoint.
 * Caller must verify Google/CSRF + current DB guards on every issuance, persist
 * the winning upload session, and handle provider/DB ambiguity before exposing URLs.
 */
export function createR2UploadAdapter(
  env: R2SigningEnv,
  originals: OriginalBucket,
  clock: () => number = Date.now,
) {
  if (
    !/^[0-9a-f]{32}$/.test(env.R2_ACCOUNT_ID ?? "") ||
    !/^[0-9a-f]{32}$/.test(env.R2_ACCESS_KEY_ID ?? "") ||
    !/^[0-9a-f]{64}$/.test(env.R2_SECRET_ACCESS_KEY ?? "")
  )
    throw new R2UploadError("INTERNAL_ERROR");
  const origin = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const signer = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    service: "s3",
    region: "auto",
    retries: 0,
  });

  async function sign(
    key: string,
    headers: Record<string, string>,
    window: ReturnType<typeof signingWindow>,
    part?: { uploadId: string; number: number },
  ) {
    const url = new URL(`/${originalsBucketName}/${key}`, origin);
    url.searchParams.set("X-Amz-Expires", String(window.seconds));
    if (part) {
      url.searchParams.set("uploadId", part.uploadId);
      url.searchParams.set("partNumber", String(part.number));
    }
    try {
      // sign() only; never use AwsClient.fetch() or grant GET/DELETE/complete URLs.
      const signed = await signer.sign(url, {
        method: "PUT",
        headers,
        redirect: "manual",
        aws: { signQuery: true, allHeaders: true, datetime: window.datetime },
      });
      return signed.url;
    } catch {
      throw new R2UploadError("INTERNAL_ERROR");
    }
  }

  return {
    /** Fixed-target server read. Neither browser errors nor resume() prove absence. */
    async inspectMultipart(
      identity: OriginalIdentity,
      uploadId: string,
      fetcher: typeof fetch = fetch,
      signal?: AbortSignal,
    ): Promise<"present" | "missing"> {
      const url = new URL(
        `/${originalsBucketName}/${keyFor(identity)}`,
        origin,
      );
      url.searchParams.set("uploadId", providerId(uploadId));
      url.searchParams.set("max-parts", "1");
      const deadline = AbortSignal.timeout(8000);
      const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      let response: Response | undefined;
      try {
        bounded.throwIfAborted();
        const signed = await signer.sign(url, {
          method: "GET",
          redirect: "manual",
          signal: bounded,
        });
        response = await fetcher(signed, {
          redirect: "manual",
          signal: bounded,
          cache: "no-store",
        });
        if (response.redirected) throw new Error();
        if (response.status === 200) return "present";
        if (
          response.status !== 404 ||
          !/^(?:application|text)\/xml(?:;|$)/i.test(
            response.headers.get("content-type") ?? "",
          )
        )
          throw new Error();
        const reader = response.body?.getReader();
        if (!reader) throw new Error();
        const cancel = () => void reader.cancel().catch(() => {});
        bounded.addEventListener("abort", cancel, { once: true });
        let text = "",
          size = 0;
        const decoder = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        });
        try {
          for (;;) {
            bounded.throwIfAborted();
            const chunk = await reader.read();
            bounded.throwIfAborted();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 8192) throw new Error();
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          cancel();
          bounded.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
        // Strict known S3 error shape: no DTD, nested/duplicate Code, HTML, or
        // permissive substring matching. Unknown XML fails closed.
        if (
          !/^(?:<\?xml\s+version="1\.0"(?:\s+encoding="UTF-8")?\s*\?>\s*)?<Error>\s*<Code>NoSuchUpload<\/Code>\s*(?:<(Message|RequestId|HostId|Resource)>[^<>]*<\/\1>\s*)*<\/Error>\s*$/.test(
            text,
          )
        )
          throw new Error();
        return "missing";
      } catch {
        throw new R2UploadError("INTERNAL_ERROR");
      } finally {
        void response?.body?.cancel().catch(() => {});
      }
    },

    async singlePut(
      identity: OriginalIdentity,
      sizeBytes: number,
      declaredContentType: string,
      expiresAt: string,
    ): Promise<SignedSinglePut> {
      const key = keyFor(identity);
      if (planR2Upload(sizeBytes).mode !== "single")
        throw new R2UploadError("INVALID_INPUT");
      const required_headers = {
        "content-type": contentType(declaredContentType),
        "if-none-match": "*",
      };
      const window = signingWindow(expiresAt, clock());
      return {
        put_url: await sign(key, required_headers, window),
        required_headers,
        expires_at: window.expiresAt,
      };
    },

    async beginMultipart(
      identity: OriginalIdentity,
      sizeBytes: number,
      declaredContentType: string,
    ) {
      const key = keyFor(identity);
      const plan = planR2Upload(sizeBytes);
      if (plan.mode !== "multipart") throw new R2UploadError("INVALID_INPUT");
      const type = contentType(declaredContentType);
      try {
        const upload = await originals.createMultipartUpload(key, {
          httpMetadata: { contentType: type },
        });
        if (upload.key !== key) throw new Error("provider mismatch");
        const uploadId = providerId(upload.uploadId);
        // Server-only provisional result. Not persisted, not an UploadTicket.
        return { ...plan, providerUploadId: uploadId };
      } catch {
        // Never auto-retry creation: its outcome may be unknown.
        throw new R2UploadError("INTERNAL_ERROR");
      }
    },

    async partPuts(
      identity: OriginalIdentity,
      sizeBytes: number,
      uploadId: string,
      partNumbers: readonly number[],
      expiresAt: string,
    ): Promise<SignedPartPut[]> {
      const key = keyFor(identity);
      const plan = planR2Upload(sizeBytes);
      const id = providerId(uploadId);
      if (
        plan.mode !== "multipart" ||
        !Array.isArray(partNumbers) ||
        partNumbers.length < 1 ||
        partNumbers.length > 100 ||
        new Set(partNumbers).size !== partNumbers.length ||
        partNumbers.some(
          (number) =>
            !Number.isInteger(number) || number < 1 || number > plan.partCount,
        )
      )
        throw new R2UploadError("INVALID_INPUT");
      const window = signingWindow(expiresAt, clock());
      return Promise.all(
        partNumbers.map(async (part_number) => ({
          part_number,
          put_url: await sign(key, {}, window, {
            uploadId: id,
            number: part_number,
          }),
          expires_at: window.expiresAt,
        })),
      );
    },

    async abortMultipart(identity: OriginalIdentity, uploadId: string) {
      const key = keyFor(identity);
      const id = providerId(uploadId);
      try {
        // Only abort a known losing/uncommitted session. Caller owns this decision.
        await originals.resumeMultipartUpload(key, id).abort();
      } catch {
        throw new R2UploadError("INTERNAL_ERROR");
      }
    },
  };
}
