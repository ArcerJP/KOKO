import { originalKey } from "@koko/contract";
import type { components, operations } from "@koko/contract/api";
import { ApiFailure } from "./client";

export type UploadRequest = components["schemas"]["UploadRequest"];
export type UploadTicket = components["schemas"]["UploadTicket"];
export type PartTickets =
  operations["signUploadParts"]["responses"][200]["content"]["application/json"];
export type CompleteUpload =
  operations["completeUpload"]["requestBody"]["content"]["application/json"];
export type UploadReceipt = components["schemas"]["PostStatus"];
export const uploadUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && uploadUuid.test(value);
}
function contentType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[\x20-\x7e]{1,255}$/.test(value) &&
    value.trim() === value
  );
}
function reject(): never {
  throw new ApiFailure("INTERNAL_ERROR");
}
export function uploadRequest(value: unknown): UploadRequest {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "client_request_id",
          "kind",
          "content_type",
          "file_size_bytes",
          "original_scope",
          "theme_id",
        ].includes(key),
    ) ||
    !validId(value.client_request_id) ||
    (value.kind !== "photo" && value.kind !== "video") ||
    !contentType(value.content_type) ||
    typeof value.file_size_bytes !== "number" ||
    !Number.isSafeInteger(value.file_size_bytes) ||
    value.file_size_bytes < 1 ||
    (value.kind === "photo"
      ? value.original_scope !== "photo_file"
      : value.original_scope !== "client_trimmed" &&
        value.original_scope !== "full_video_fallback") ||
    (value.theme_id != null && !validId(value.theme_id))
  )
    throw new ApiFailure("INVALID_INPUT");
  return {
    client_request_id: value.client_request_id.toLowerCase(),
    kind: value.kind as UploadRequest["kind"],
    content_type: value.content_type,
    file_size_bytes: value.file_size_bytes,
    original_scope: value.original_scope as UploadRequest["original_scope"],
    theme_id:
      typeof value.theme_id === "string" ? value.theme_id.toLowerCase() : null,
  };
}
export function partNumbers(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 100 ||
    new Set(value).size !== value.length ||
    value.some((n) => !Number.isInteger(n) || n < 1 || n > 10000)
  )
    throw new ApiFailure("INVALID_INPUT");
  return [...value];
}
export function completion(value: unknown): CompleteUpload {
  if (
    !record(value) ||
    !validId(value.upload_id) ||
    Object.keys(value).some((k) => k !== "upload_id" && k !== "parts")
  )
    throw new ApiFailure("INVALID_INPUT");
  if (value.parts === undefined)
    return { upload_id: value.upload_id.toLowerCase() };
  if (
    !Array.isArray(value.parts) ||
    value.parts.length < 1 ||
    value.parts.length > 10000
  )
    throw new ApiFailure("INVALID_INPUT");
  const parts = value.parts.map((part, i) => {
    if (
      !record(part) ||
      Object.keys(part).length !== 2 ||
      part.part_number !== i + 1 ||
      typeof part.etag !== "string" ||
      !/^(?:[0-9a-f]{32}|"[0-9a-f]{32}")$/.test(part.etag)
    )
      throw new ApiFailure("INVALID_INPUT");
    return { part_number: i + 1, etag: part.etag.replaceAll('"', "") };
  });
  return { upload_id: value.upload_id.toLowerCase(), parts };
}

export type UploadDestination = { eventId: string; r2AccountId: string };
export function assertDestination(destination: UploadDestination) {
  if (
    !validId(destination.eventId) ||
    !/^[0-9a-f]{32}$/.test(destination.r2AccountId)
  )
    throw new TypeError("アップロード設定が不正です。");
}
function expiry(value: unknown, now: number): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value)) ||
    Date.parse(value) > now + 900_000
  )
    reject();
  if (Date.parse(value) <= now) throw new ApiFailure("UPLOAD_EXPIRED");
  return value;
}

/** Destination validation, not signature verification. R2 validates the signature. */
export function signedPut(
  value: unknown,
  expiresAt: string,
  destination: UploadDestination,
  part?: number,
  expectedPostId?: string,
): URL {
  assertDestination(destination);
  if (typeof value !== "string" || value.length > 8192) reject();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject();
  }
  const path =
    /^\/koko-dev-originals\/events\/([^/]+)\/posts\/([^/]+)\/original\/([^/]+)\.bin$/.exec(
      url.pathname,
    );
  if (
    url.origin !==
      `https://${destination.r2AccountId}.r2.cloudflarestorage.com` ||
    url.username ||
    url.password ||
    url.hash ||
    !path ||
    path[1] !== destination.eventId.toLowerCase() ||
    !validId(path[2]) ||
    !validId(path[3]) ||
    url.pathname !==
      `/koko-dev-originals/${originalKey(path[1], path[2], path[3])}` ||
    (expectedPostId && path[2] !== expectedPostId.toLowerCase())
  )
    reject();
  const query = url.searchParams;
  const names = [
    "X-Amz-Algorithm",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Expires",
    "X-Amz-SignedHeaders",
    "X-Amz-Signature",
    "X-Amz-Content-Sha256",
    ...(part ? ["partNumber", "uploadId"] : []),
  ];
  for (const key of query.keys())
    if (!names.includes(key) || query.getAll(key).length !== 1) reject();
  const date = query.get("X-Amz-Date") ?? "";
  const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  const seconds = Number(query.get("X-Amz-Expires"));
  if (
    !stamp ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 900 ||
    query.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" ||
    !/^[0-9a-f]{32}\/\d{8}\/auto\/s3\/aws4_request$/.test(
      query.get("X-Amz-Credential") ?? "",
    ) ||
    !(query.get("X-Amz-Credential") ?? "").includes(`/${date.slice(0, 8)}/`) ||
    !/^[0-9a-f]{64}$/.test(query.get("X-Amz-Signature") ?? "") ||
    (query.has("X-Amz-Content-Sha256") &&
      query.get("X-Amz-Content-Sha256") !== "UNSIGNED-PAYLOAD") ||
    query.get("X-Amz-SignedHeaders") !==
      (part ? "host" : "content-type;host;if-none-match")
  )
    reject();
  const signedAt = Date.parse(
    `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}Z`,
  );
  if (signedAt + seconds * 1000 !== Date.parse(expiresAt)) reject();
  if (
    part &&
    (query.get("partNumber") !== String(part) ||
      !/^[\x21-\x7e]{1,2048}$/.test(query.get("uploadId") ?? ""))
  )
    reject();
  return url;
}
export function ticket(
  value: unknown,
  destination: UploadDestination,
  now: number,
): UploadTicket {
  assertDestination(destination);
  if (!record(value) || !validId(value.post_id) || !validId(value.upload_id))
    reject();
  const base = {
    post_id: value.post_id.toLowerCase(),
    upload_id: value.upload_id.toLowerCase(),
    expires_at: expiry(value.expires_at, now),
  };
  if (value.mode === "single") {
    if (
      value.part_size_bytes !== undefined ||
      !record(value.required_headers) ||
      Object.keys(value.required_headers).length !== 2 ||
      !contentType(value.required_headers["content-type"]) ||
      value.required_headers["if-none-match"] !== "*"
    )
      reject();
    const url = signedPut(
      value.put_url,
      base.expires_at,
      destination,
      undefined,
      base.post_id,
    );
    return {
      ...base,
      mode: "single",
      put_url: url.href,
      required_headers: {
        "content-type": value.required_headers["content-type"],
        "if-none-match": "*",
      },
    };
  }
  if (
    value.mode !== "multipart" ||
    value.put_url !== undefined ||
    value.required_headers !== undefined ||
    typeof value.part_size_bytes !== "number" ||
    !Number.isSafeInteger(value.part_size_bytes) ||
    value.part_size_bytes < 5 * 1024 ** 2 ||
    value.part_size_bytes > 5 * 1024 ** 3
  )
    reject();
  return { ...base, mode: "multipart", part_size_bytes: value.part_size_bytes };
}
export function tickets(
  value: unknown,
  numbers: number[],
  destination: UploadDestination,
  now: number,
): PartTickets {
  if (
    !record(value) ||
    !Array.isArray(value.parts) ||
    value.parts.length !== numbers.length
  )
    reject();
  const seen = new Set<number>();
  let identity: string | undefined;
  const parts = value.parts.map((p) => {
    if (
      !record(p) ||
      typeof p.part_number !== "number" ||
      !numbers.includes(p.part_number) ||
      seen.has(p.part_number)
    )
      reject();
    seen.add(p.part_number);
    const expires_at = expiry(p.expires_at, now);
    const url = signedPut(p.put_url, expires_at, destination, p.part_number);
    const key = `${url.pathname}?${url.searchParams.get("uploadId")}`;
    if (identity !== undefined && identity !== key) reject();
    identity = key;
    return { part_number: p.part_number, put_url: url.href, expires_at };
  });
  return { parts: parts.sort((a, b) => a.part_number - b.part_number) };
}
export function receipt(
  value: unknown,
  postId: string,
  eventId: string,
): UploadReceipt {
  if (
    !record(value) ||
    value.id !== postId ||
    value.event_id !== eventId ||
    value.status !== "uploaded" ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 2 ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at))
  )
    reject();
  return {
    id: postId,
    event_id: eventId,
    status: "uploaded",
    version: value.version,
    created_at: value.created_at,
  };
}
