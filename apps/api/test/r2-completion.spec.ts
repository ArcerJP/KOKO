import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { originalKey } from "@koko/contract";
import {
  normalizeCompletionParts,
  multipartEtag,
  verifyCompletedOriginal,
} from "../src/r2-completion";
const identity = {
  eventId: "11111111-1111-4111-8111-111111111111",
  postId: "22222222-2222-4222-8222-222222222222",
  assetId: "33333333-3333-4333-8333-333333333333",
};
const key = originalKey(identity.eventId, identity.postId, identity.assetId);
const size = 67108865;
const parts = Array.from({ length: 9 }, (_, i) => ({
  part_number: i + 1,
  etag: "a".repeat(32),
}));
const metadata = (extra = {}) =>
  ({
    key,
    size: 123,
    etag: "a".repeat(32),
    version: "fixture-version",
    ...extra,
  }) as R2Object;
describe("completion manifest", () => {
  it("normalizes quoted and uppercase ETags, ordering, and rejects malformed fields", () => {
    expect(
      normalizeCompletionParts([
        { part_number: 2, etag: '"' + "B".repeat(32) + '"' },
        { part_number: 1, etag: "a".repeat(32) },
      ]),
    ).toEqual([
      { part_number: 1, etag: "a".repeat(32) },
      { part_number: 2, etag: "b".repeat(32) },
    ]);
    for (const value of [
      null,
      [],
      [{}],
      [{ part_number: 1, etag: "bad" }],
      [{ part_number: 1, etag: "a".repeat(32), extra: 1 }],
      parts.slice(1),
      [parts[0], parts[0]],
    ])
      expect(normalizeCompletionParts(value)).toBeNull();
  });
  it("matches Cloudflare's independent published multipart vector", async () => {
    expect(
      await multipartEtag([
        { part_number: 1, etag: "bce6bf66aeb76c7040fdd5f4eccb78e6" },
        { part_number: 2, etag: "8165449fc15bbf43d3b674595cbcc406" },
      ]),
    ).toBe("f77dc0eecdebcd774a2a22cb393ad2ff-2");
  });
});
describe("R2 verification", () => {
  it("single uses only HEAD and returns no body/MIME", async () => {
    const head = vi.fn(async () => metadata());
    const resumeMultipartUpload = vi.fn();
    expect(
      await verifyCompletedOriginal(
        { head, resumeMultipartUpload },
        identity,
        123,
        null,
        [],
      ),
    ).toEqual({
      object_key: key,
      size: 123,
      etag: "a".repeat(32),
      version: "fixture-version",
    });
    expect(head).toHaveBeenCalledExactlyOnceWith(key);
    expect(resumeMultipartUpload).not.toHaveBeenCalled();
  });
  it.each([
    null,
    metadata({ size: 124 }),
    metadata({ key: "other" }),
    metadata({ version: "" }),
    metadata({ etag: "not-etag" }),
  ])("rejects missing or different original", async (value) => {
    await expect(
      verifyCompletedOriginal(
        { head: vi.fn(async () => value), resumeMultipartUpload: vi.fn() },
        identity,
        123,
        null,
        [],
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_INCOMPLETE" });
  });
  it("never re-completes an existing multipart object", async () => {
    const resumeMultipartUpload = vi.fn();
    const found = metadata({ size, etag: await multipartEtag(parts) });
    await verifyCompletedOriginal(
      { head: vi.fn(async () => found), resumeMultipartUpload },
      identity,
      size,
      "provider",
      parts,
    );
    expect(resumeMultipartUpload).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "reconciles complete success or lost response by HEAD (lost=%s)",
    async (lost) => {
      const found = metadata({ size, etag: await multipartEtag(parts) });
      const head = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(found);
      const complete = vi.fn(async () => {
        if (lost) throw new Error("secret provider detail");
        return found;
      });
      const abort = vi.fn();
      const uploadPart = vi.fn();
      const resumeMultipartUpload = vi.fn(() => ({
        key,
        uploadId: "provider",
        complete,
        abort,
        uploadPart,
      }));
      expect(
        (
          await verifyCompletedOriginal(
            { head, resumeMultipartUpload },
            identity,
            size,
            "provider",
            parts,
          )
        ).version,
      ).toBe("fixture-version");
      expect(complete).toHaveBeenCalledTimes(1);
      expect(abort).not.toHaveBeenCalled();
    },
  );
  it("absent after provider failure stays retryable without blind abort", async () => {
    const abort = vi.fn();
    const complete = vi.fn(async () => {
      throw new Error("private");
    });
    const bucket = {
      head: vi.fn(async () => null),
      resumeMultipartUpload: vi.fn(() => ({
        key,
        uploadId: "provider",
        complete,
        abort,
        uploadPart: vi.fn(),
      })),
    };
    await expect(
      verifyCompletedOriginal(bucket, identity, size, "provider", parts),
    ).rejects.toMatchObject({
      code: "UPLOAD_INCOMPLETE",
      message: "UPLOAD_INCOMPLETE",
    });
    expect(abort).not.toHaveBeenCalled();
  });
  it("provider response and HEAD must observe the same version", async () => {
    const found = metadata({ size, etag: await multipartEtag(parts) });
    const bucket = {
      head: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(found),
      resumeMultipartUpload: vi.fn(() => ({
        key,
        uploadId: "provider",
        complete: vi.fn(async () =>
          metadata({ size, etag: found.etag, version: "other" }),
        ),
        abort: vi.fn(),
        uploadPart: vi.fn(),
      })),
    };
    await expect(
      verifyCompletedOriginal(bucket, identity, size, "provider", parts),
    ).rejects.toMatchObject({ code: "UPLOAD_INCOMPLETE" });
  });
  it("sanitizes HEAD errors", async () => {
    await expect(
      verifyCompletedOriginal(
        {
          head: vi.fn(async () => {
            throw new Error("secret");
          }),
          resumeMultipartUpload: vi.fn(),
        },
        identity,
        123,
        null,
        [],
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "INTERNAL_ERROR",
    });
  });
  it("verifies real local single and multipart objects without remote storage", async () => {
    const first = await env.ORIGINALS_BUCKET.put(key, "abc");
    expect(
      (
        await verifyCompletedOriginal(
          env.ORIGINALS_BUCKET,
          identity,
          3,
          null,
          [],
        )
      ).version,
    ).toBe(first!.version);
    const multipartIdentity = { ...identity, assetId: crypto.randomUUID() };
    const multipartKey = originalKey(
      multipartIdentity.eventId,
      multipartIdentity.postId,
      multipartIdentity.assetId,
    );
    const upload =
      await env.ORIGINALS_BUCKET.createMultipartUpload(multipartKey);
    const uploaded: { part_number: number; etag: string }[] = [];
    const localParts: R2UploadedPart[] = [];
    const chunk = new Uint8Array(8 * 1024 * 1024);
    for (let partNumber = 1; partNumber <= 9; partNumber++) {
      const part = await upload.uploadPart(
        partNumber,
        partNumber === 9 ? new Uint8Array(1) : chunk,
      );
      localParts.push(part);
      const md5 = new Uint8Array(
        await crypto.subtle.digest(
          "MD5",
          partNumber === 9 ? new Uint8Array(1) : chunk,
        ),
      );
      uploaded.push({
        part_number: partNumber,
        etag: Array.from(md5, (b) => b.toString(16).padStart(2, "0")).join(""),
      });
    }
    const observedBucket = {
      head: async (objectKey: string) => {
        const observed = await env.ORIGINALS_BUCKET.head(objectKey);
        return observed;
      },
      resumeMultipartUpload: (objectKey: string, uploadId: string) => {
        const local = env.ORIGINALS_BUCKET.resumeMultipartUpload(
          objectKey,
          uploadId,
        );
        return {
          key: local.key,
          uploadId: local.uploadId,
          uploadPart: local.uploadPart.bind(local),
          abort: local.abort.bind(local),
          complete: async (selected: R2UploadedPart[]) => {
            // Miniflare uses random part ETags, unlike R2 S3's documented MD5.
            // Translate ONLY this local binding fixture, retaining real assembly,
            // final HEAD/size/ETag/version validation. Never relax production checks.
            expect(selected).toEqual(
              uploaded.map((p) => ({
                partNumber: p.part_number,
                etag: p.etag,
              })),
            );
            return local.complete(localParts);
          },
        };
      },
    };
    const result = await verifyCompletedOriginal(
      observedBucket,
      multipartIdentity,
      size,
      upload.uploadId,
      uploaded,
    );
    expect(result.size).toBe(size);
    expect(result.etag).toBe(await multipartEtag(uploaded));
    expect(
      await verifyCompletedOriginal(
        env.ORIGINALS_BUCKET,
        multipartIdentity,
        size,
        upload.uploadId,
        uploaded,
      ),
    ).toEqual(result);
  });
});
