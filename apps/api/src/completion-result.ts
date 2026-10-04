import { originalKey, type ApiErrorCode } from "@koko/contract";
import { object, uuid } from "./api-context";
import {
  CompletionError,
  normalizeCompletionParts,
  type CompletionPart,
} from "./r2-completion";
import { planR2Upload, type OriginalIdentity } from "./r2-upload";

export const completionErrors: readonly ApiErrorCode[] = [
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID_INPUT",
  "CONSENT_REQUIRED",
  "ACCOUNT_BANNED",
  "EVENT_CLOSED",
  "PUBLICATION_STOPPED",
  "THEME_UNAVAILABLE",
  "STATE_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "UPLOAD_INCOMPLETE",
  "INTERNAL_ERROR",
];

/** Pick only the immutable acceptance receipt, never internal RPC fields. */
export function completionReceipt(
  value: unknown,
  eventId: string,
  postId: string,
) {
  if (!object(value) || value.code !== "completed") return null;
  const post = value.post;
  if (
    !object(post) ||
    post.id !== postId ||
    post.event_id !== eventId ||
    post.status !== "uploaded" ||
    typeof post.version !== "number" ||
    !Number.isSafeInteger(post.version) ||
    post.version < 2 ||
    typeof post.created_at !== "string" ||
    !Number.isFinite(Date.parse(post.created_at))
  )
    throw new CompletionError("INTERNAL_ERROR");
  return {
    id: postId,
    event_id: eventId,
    status: "uploaded" as const,
    version: post.version,
    created_at: post.created_at,
  };
}

export function preparedCompletion(
  value: unknown,
  expected: {
    eventId: string;
    postId: string;
    uploadId?: string;
    assetId?: string;
    parts?: CompletionPart[];
  },
) {
  if (
    !object(value) ||
    value.code !== "prepared" ||
    value.post_id !== expected.postId ||
    typeof value.upload_id !== "string" ||
    !uuid.test(value.upload_id) ||
    (expected.uploadId !== undefined &&
      value.upload_id !== expected.uploadId) ||
    typeof value.asset_id !== "string" ||
    !uuid.test(value.asset_id) ||
    (expected.assetId !== undefined && value.asset_id !== expected.assetId) ||
    value.object_key !==
      originalKey(expected.eventId, expected.postId, value.asset_id) ||
    typeof value.file_size_bytes !== "number" ||
    typeof value.post_version !== "number" ||
    !Number.isSafeInteger(value.post_version) ||
    value.post_version < 1
  )
    throw new CompletionError("INTERNAL_ERROR");
  const parts =
    Array.isArray(value.parts) && value.parts.length === 0
      ? []
      : normalizeCompletionParts(value.parts);
  if (
    !parts ||
    (expected.parts !== undefined &&
      JSON.stringify(parts) !== JSON.stringify(expected.parts))
  )
    throw new CompletionError("INTERNAL_ERROR");
  const plan = planR2Upload(value.file_size_bytes);
  if (
    plan.mode !== value.mode ||
    (plan.mode === "single"
      ? parts.length !== 0 || value.provider_upload_id !== null
      : parts.length !== plan.partCount ||
        typeof value.provider_upload_id !== "string" ||
        !/^[\x21-\x7e]{1,2048}$/.test(value.provider_upload_id))
  )
    throw new CompletionError("INTERNAL_ERROR");
  return {
    identity: {
      eventId: expected.eventId,
      postId: expected.postId,
      assetId: value.asset_id,
    } satisfies OriginalIdentity,
    size: value.file_size_bytes,
    providerId: value.provider_upload_id as string | null,
    parts,
    version: value.post_version,
  };
}
