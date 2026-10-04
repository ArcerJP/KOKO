import { errors, type ErrorCode } from "@koko/contract";
import { ApiFailure } from "../api/client";
import {
  completion,
  record,
  uploadRequest,
  validId,
  type CompleteUpload,
  type UploadRequest,
} from "../api/upload-contract";

export type UploadCheckpoint = {
  parts: NonNullable<CompleteUpload["parts"]>;
  identity: string;
};
export type QueueSession = {
  postId: string;
  uploadId: string;
  mode: "single" | "multipart";
  partSize: number | null;
};
export type QueueRecord = {
  version: 1;
  id: string;
  owner: string;
  eventId: string;
  request: UploadRequest;
  createdAt: number;
  phase: "queued" | "transferring" | "completing" | "done";
  session: QueueSession | null;
  checkpoint: UploadCheckpoint | null;
  manifest: CompleteUpload | null;
  failures: number;
  nextAttemptAt: number;
  paused: boolean;
  error: ErrorCode | null;
};

function exact(value: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(value).length === keys.length && keys.every((k) => k in value)
  );
}
const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;
export function storageFailure(): ApiFailure {
  return new ApiFailure("LOCAL_STORAGE_UNAVAILABLE");
}

/** Stored data is untrusted. Never spread arbitrary persisted fields into requests. */
export function queueRecord(
  value: unknown,
  owner: string,
  eventId: string,
): QueueRecord {
  try {
    if (
      !record(value) ||
      !exact(value, [
        "version",
        "id",
        "owner",
        "eventId",
        "request",
        "createdAt",
        "phase",
        "session",
        "checkpoint",
        "manifest",
        "failures",
        "nextAttemptAt",
        "paused",
        "error",
      ]) ||
      value.version !== 1 ||
      !validId(value.id) ||
      !validId(owner) ||
      !validId(eventId) ||
      value.owner !== owner ||
      value.eventId !== eventId ||
      !integer(value.createdAt) ||
      !integer(value.failures) ||
      value.failures > 4 ||
      !integer(value.nextAttemptAt) ||
      typeof value.paused !== "boolean" ||
      !(
        value.error === null ||
        (typeof value.error === "string" && Object.hasOwn(errors, value.error))
      ) ||
      !["queued", "transferring", "completing", "done"].includes(
        value.phase as string,
      )
    )
      throw storageFailure();
    const request = uploadRequest(value.request);
    if (request.client_request_id !== value.id) throw storageFailure();
    let session: QueueSession | null = null;
    if (value.session !== null) {
      const s = value.session;
      if (
        !record(s) ||
        !exact(s, ["postId", "uploadId", "mode", "partSize"]) ||
        !validId(s.postId) ||
        !validId(s.uploadId) ||
        (s.mode !== "single" && s.mode !== "multipart") ||
        (s.mode === "single"
          ? s.partSize !== null
          : !integer(s.partSize) ||
            s.partSize < 5 * 1024 ** 2 ||
            s.partSize > 5 * 1024 ** 3)
      )
        throw storageFailure();
      session = {
        postId: s.postId,
        uploadId: s.uploadId,
        mode: s.mode,
        partSize: s.partSize as number | null,
      };
    }
    if ((value.phase === "queued") !== (session === null))
      throw storageFailure();
    let checkpoint: UploadCheckpoint | null = null;
    if (value.checkpoint !== null) {
      const c = value.checkpoint;
      if (
        !session ||
        session.mode !== "multipart" ||
        !record(c) ||
        !exact(c, ["parts", "identity"]) ||
        typeof c.identity !== "string" ||
        !/^[a-f0-9]{64}$/.test(c.identity)
      )
        throw storageFailure();
      const parts = completion({
        upload_id: session.uploadId,
        parts: c.parts,
      }).parts!;
      if (parts.length > Math.ceil(request.file_size_bytes / session.partSize!))
        throw storageFailure();
      checkpoint = { identity: c.identity, parts };
    }
    let manifest: CompleteUpload | null = null;
    if (value.manifest !== null) {
      if (!session) throw storageFailure();
      manifest = completion(value.manifest);
      if (
        manifest.upload_id !== session.uploadId ||
        (session.mode === "single"
          ? manifest.parts !== undefined
          : manifest.parts?.length !==
            Math.ceil(request.file_size_bytes / session.partSize!))
      )
        throw storageFailure();
    }
    if (
      (value.phase === "completing" || value.phase === "done") !==
      (manifest !== null)
    )
      throw storageFailure();
    return {
      version: 1,
      id: value.id,
      owner,
      eventId,
      request,
      createdAt: value.createdAt,
      phase: value.phase as QueueRecord["phase"],
      session,
      checkpoint,
      manifest,
      failures: value.failures,
      nextAttemptAt: value.nextAttemptAt,
      paused: value.paused,
      error: value.error as ErrorCode | null,
    };
  } catch {
    throw storageFailure();
  }
}

export interface QueueStore {
  list(): Promise<QueueRecord[]>;
  get(id: string): Promise<QueueRecord | null>;
  add(item: QueueRecord, blob: Blob): Promise<void>;
  save(item: QueueRecord): Promise<void>;
  blob(id: string): Promise<Blob>;
  remove(id: string): Promise<void>;
}
