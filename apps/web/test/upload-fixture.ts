import type { UploadRequest } from "../src/api/upload-contract";

export const eventId = "00000000-0000-4000-8000-000000000001";
export const postId = "00000000-0000-4000-8000-000000000002";
export const uploadId = "00000000-0000-4000-8000-000000000003";
export const assetId = "00000000-0000-4000-8000-000000000004";
export const accountId = "a".repeat(32);
export const destination = { eventId, r2AccountId: accountId };
export const csrf = "synthetic-csrf-token-for-tests-only";
export const origin = "https://web.example.test";
export const input: UploadRequest = {
  client_request_id: "00000000-0000-4000-8000-000000000005",
  kind: "photo",
  content_type: "image/png",
  file_size_bytes: 3,
  original_scope: "photo_file",
};
export function signed(part?: number, now = Date.now()) {
  const date = new Date(Math.floor(now / 1000) * 1000);
  const url = new URL(
    `https://${accountId}.r2.cloudflarestorage.com/koko-dev-originals/events/${eventId}/posts/${postId}/original/${assetId}.bin`,
  );
  const stamp = date.toISOString().replace(/[:-]|\.000/g, "");
  for (const [key, value] of Object.entries({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${"b".repeat(32)}/${stamp.slice(0, 8)}/auto/s3/aws4_request`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": "600",
    "X-Amz-SignedHeaders": part ? "host" : "content-type;host;if-none-match",
    "X-Amz-Signature": "c".repeat(64),
  }))
    url.searchParams.set(key, value);
  if (part) {
    url.searchParams.set("partNumber", String(part));
    url.searchParams.set("uploadId", "synthetic-provider-id");
  }
  return {
    put_url: url.href,
    expires_at: new Date(date.getTime() + 600_000).toISOString(),
  };
}
export function single() {
  return {
    post_id: postId,
    upload_id: uploadId,
    mode: "single" as const,
    ...signed(),
    required_headers: { "content-type": "image/png", "if-none-match": "*" },
  };
}
export function multipart() {
  return {
    post_id: postId,
    upload_id: uploadId,
    mode: "multipart" as const,
    expires_at: signed().expires_at,
    part_size_bytes: 5 * 1024 ** 2,
  };
}
export const receipt = {
  id: postId,
  event_id: eventId,
  status: "uploaded",
  version: 2,
  created_at: "2026-10-05T00:00:00.000Z",
};
