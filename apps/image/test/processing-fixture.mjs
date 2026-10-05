import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
export const uuid = (n) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const hash = (b, algorithm = "sha256") =>
  createHash(algorithm).update(b).digest("hex");
export const input = Buffer.from("SYNTHETIC_INPUT");
export const job = { eventId: uuid(1), postId: uuid(2), jobId: uuid(20) };
export const url = "https://abcdefghijklmnopqrst.supabase.co";
export const key = "sb_secret_fixture_only";
export function plan(bytes = input) {
  return {
    jobId: job.jobId,
    leaseId: uuid(21),
    postVersion: 3,
    expiresAt: Date.now() + 120000,
    original: {
      eventId: job.eventId,
      postId: job.postId,
      assetId: uuid(3),
      size: bytes.length,
      etag: hash(bytes, "md5"),
      sha256: hash(bytes),
    },
    deliveries: [
      ["600", "webp"],
      ["600", "jpg"],
      ["1600", "webp"],
      ["1600", "jpg"],
    ].map(([variant, format], i) => ({
      eventId: job.eventId,
      assetId: uuid(i + 4),
      variant,
      format,
    })),
  };
}
export function outputs() {
  return [
    "ai-1024.jpg",
    "display-600.webp",
    "display-600.jpg",
    "display-1600.webp",
    "display-1600.jpg",
  ].map((name) => {
    const bytes = Buffer.from(name);
    return {
      name,
      bytes,
      sha256: hash(bytes),
      width: 40,
      height: 20,
      contentType: name.endsWith(".jpg") ? "image/jpeg" : "image/webp",
    };
  });
}
export const receipt = (p) => ({
  originalSha256: hash(input),
  deliveries: p.deliveries.map((d, i) => ({
    ...d,
    outcome: "stored",
    sha256: String(i + 1).repeat(64),
    size: 20,
    width: 40,
    height: 20,
  })),
});
export const json = (body, init = {}) =>
  new globalThis.Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
