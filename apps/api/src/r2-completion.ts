import { originalKey, type ApiErrorCode } from "@koko/contract";
import { object } from "./api-context";
import { planR2Upload, type OriginalIdentity } from "./r2-upload";

export type CompletionPart = { part_number: number; etag: string };
export type CompletionBucket = Pick<R2Bucket, "head" | "resumeMultipartUpload">;
export class CompletionError extends Error {
  constructor(readonly code: ApiErrorCode) {
    super(code);
    this.name = "CompletionError";
  }
}

/** Canonical order and unquoted lowercase R2 part MD5. Not a media safety hash. */
export function normalizeCompletionParts(
  value: unknown,
): CompletionPart[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10000)
    return null;
  const parts: CompletionPart[] = [];
  for (const item of value) {
    if (
      !object(item) ||
      Object.keys(item).length !== 2 ||
      typeof item.part_number !== "number" ||
      !Number.isInteger(item.part_number) ||
      item.part_number < 1 ||
      item.part_number > 10000 ||
      typeof item.etag !== "string" ||
      !/^(?:[a-f0-9]{32}|"[a-f0-9]{32}")$/i.test(item.etag)
    )
      return null;
    parts.push({
      part_number: item.part_number,
      etag: item.etag.replaceAll('"', "").toLowerCase(),
    });
  }
  parts.sort((a, b) => a.part_number - b.part_number);
  if (parts.some((part, i) => part.part_number !== i + 1)) return null;
  return parts;
}

export async function multipartEtag(
  parts: readonly CompletionPart[],
): Promise<string> {
  const bytes = new Uint8Array(parts.length * 16);
  parts.forEach((part, i) => {
    for (let j = 0; j < 16; j++)
      bytes[i * 16 + j] = Number.parseInt(
        part.etag.slice(j * 2, j * 2 + 2),
        16,
      );
  });
  // Workers supports MD5 for provider compatibility. Never use it as a security verdict.
  const digest = new Uint8Array(await crypto.subtle.digest("MD5", bytes));
  return `${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}-${parts.length}`;
}

/** Only call AFTER DB ownership/guards and frozen manifest. No GET body or deletion. */
export async function verifyCompletedOriginal(
  bucket: CompletionBucket,
  identity: OriginalIdentity,
  size: number,
  providerId: string | null,
  parts: readonly CompletionPart[],
) {
  const key = originalKey(identity.eventId, identity.postId, identity.assetId);
  const plan = planR2Upload(size);
  if (
    plan.mode === "single"
      ? providerId !== null || parts.length !== 0
      : typeof providerId !== "string" ||
        !/^[\x21-\x7e]{1,2048}$/.test(providerId) ||
        parts.length !== plan.partCount
  )
    throw new CompletionError("INTERNAL_ERROR");
  const expectedEtag =
    plan.mode === "multipart" ? await multipartEtag(parts) : null;
  try {
    let found = await bucket.head(key);
    let completed: R2Object | undefined;
    if (!found && plan.mode === "multipart") {
      try {
        const upload = bucket.resumeMultipartUpload(key, providerId!);
        if (upload.key !== key || upload.uploadId !== providerId)
          throw new CompletionError("INTERNAL_ERROR");
        completed = await upload.complete(
          parts.map((part) => ({
            partNumber: part.part_number,
            etag: part.etag,
          })),
        );
      } catch (error) {
        if (error instanceof CompletionError) throw error;
        // Ambiguous completion / parallel winner: reconcile by HEAD, never abort
        // or create another upload. If still absent, caller may retry same manifest.
      }
      found = await bucket.head(key);
    }
    if (!found) throw new CompletionError("UPLOAD_INCOMPLETE");
    if (
      found.key !== key ||
      found.size !== size ||
      typeof found.version !== "string" ||
      !/^[\x21-\x7e]{1,1024}$/.test(found.version) ||
      (expectedEtag
        ? found.etag !== expectedEtag
        : !/^[0-9a-f]{32}$/.test(found.etag)) ||
      (completed &&
        (completed.key !== key ||
          completed.version !== found.version ||
          completed.etag !== found.etag ||
          completed.size !== found.size))
    )
      throw new CompletionError("UPLOAD_INCOMPLETE");
    return {
      object_key: key,
      size: found.size,
      etag: found.etag,
      version: found.version,
    };
  } catch (error) {
    throw error instanceof CompletionError
      ? error
      : new CompletionError("INTERNAL_ERROR");
  }
}
