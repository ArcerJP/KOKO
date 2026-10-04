import { env } from "cloudflare:workers";
import { originalKey } from "@koko/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createR2UploadAdapter,
  maxR2ObjectBytes,
  maxUploadSignatureSeconds,
  planR2Upload,
  R2UploadError,
  singleUploadThresholdBytes,
  type OriginalIdentity,
} from "../src/r2-upload";

// Synthetic values only. Signing tests never contact Cloudflare's S3 endpoint.
const credentials = {
  R2_ACCOUNT_ID: "a".repeat(32),
  R2_ACCESS_KEY_ID: "b".repeat(32),
  R2_SECRET_ACCESS_KEY: "c".repeat(64),
};
const identity: OriginalIdentity = {
  eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  postId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  assetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const now = Date.parse("2026-10-05T01:02:03.000Z");
const expiry = new Date(now + 300000).toISOString();
const large = singleUploadThresholdBytes + 1;
const adapter = (clock = () => now) =>
  createR2UploadAdapter(credentials, env.ORIGINALS_BUCKET, clock);

afterEach(() => vi.restoreAllMocks());

// Independent SigV4 verification: this does not call aws4fetch or production helpers.
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
async function hash(value: string) {
  return hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}
async function mac(key: string | ArrayBuffer, value: string) {
  const imported = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value));
}
async function validSignature(
  urlString: string,
  method: string,
  headers: Record<string, string>,
) {
  const url = new URL(urlString);
  const signature = url.searchParams.get("X-Amz-Signature");
  url.searchParams.delete("X-Amz-Signature");
  const scope = url.searchParams
    .get("X-Amz-Credential")!
    .split("/")
    .slice(1)
    .join("/");
  const date = url.searchParams.get("X-Amz-Date")!;
  const names = url.searchParams.get("X-Amz-SignedHeaders")!;
  const query = Array.from(url.searchParams.entries())
    .map(([name, value]) => `${encode(name)}=${encode(value)}`)
    .sort()
    .join("&");
  const canonicalHeaders = names
    .split(";")
    .map(
      (name) =>
        `${name}:${name === "host" ? url.host : (headers[name] ?? "").trim().replace(/\s+/g, " ")}\n`,
    )
    .join("");
  const canonical = [
    method,
    url.pathname,
    query,
    canonicalHeaders,
    names,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  let key = await mac(
    `AWS4${credentials.R2_SECRET_ACCESS_KEY}`,
    date.slice(0, 8),
  );
  for (const component of ["auto", "s3", "aws4_request"])
    key = await mac(key, component);
  const expected = hex(
    await mac(
      key,
      ["AWS4-HMAC-SHA256", date, scope, await hash(canonical)].join("\n"),
    ),
  );
  return signature === expected;
}

describe("R2 upload planning", () => {
  it.each([1, singleUploadThresholdBytes])("single boundary %s", (size) => {
    expect(planR2Upload(size)).toEqual({ mode: "single" });
  });
  it.each([large, 5 * 1024 ** 3, maxR2ObjectBytes])(
    "multipart fits provider limits: %s",
    (size) => {
      const plan = planR2Upload(size);
      expect(plan.mode).toBe("multipart");
      if (plan.mode !== "multipart") throw new Error("wrong mode");
      expect(plan.partCount).toBeGreaterThan(1);
      expect(plan.partCount).toBeLessThanOrEqual(10000);
      expect(plan.partSizeBytes).toBeGreaterThanOrEqual(5 * 1024 ** 2);
      expect(plan.partSizeBytes).toBeLessThanOrEqual(
        5 * 1024 ** 3 - 5 * 1024 ** 2,
      );
      expect(plan.partSizeBytes % 1024 ** 2).toBe(0);
      expect((plan.partCount - 1) * plan.partSizeBytes).toBeLessThan(size);
      expect(plan.partCount * plan.partSizeBytes).toBeGreaterThanOrEqual(size);
    },
  );
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "invalid size %s",
    (size) => {
      expect(() => planR2Upload(size)).toThrow("INVALID_INPUT");
    },
  );
  it("rejects only the provider object limit, not files above single PUT", () => {
    expect(() => planR2Upload(maxR2ObjectBytes + 1)).toThrow("PROVIDER_LIMIT");
    expect(planR2Upload(6 * 1024 ** 3).mode).toBe("multipart");
  });
});

describe("single PUT signatures", () => {
  it("signs exactly the canonical private original, PUT, MIME, create-only condition and deadline without fetch", async () => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network forbidden"));
    const result = await adapter().singlePut(
      identity,
      12,
      "image/jpeg",
      expiry,
    );
    const url = new URL(result.put_url);
    expect(url.origin).toBe(
      `https://${credentials.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    );
    expect(url.pathname).toBe(
      `/koko-dev-originals/${originalKey(identity.eventId, identity.postId, identity.assetId)}`,
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-type;host;if-none-match",
    );
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      `${credentials.R2_ACCESS_KEY_ID}/20261005/auto/s3/aws4_request`,
    );
    expect(result.required_headers).toEqual({
      "content-type": "image/jpeg",
      "if-none-match": "*",
    });
    expect(result.expires_at).toBe(expiry);
    expect(
      await validSignature(result.put_url, "PUT", result.required_headers),
    ).toBe(true);
    expect(result.put_url).not.toContain(credentials.R2_SECRET_ACCESS_KEY);
    expect(network).not.toHaveBeenCalled();
  });
  it("rejects reuse as GET/HEAD/DELETE or a different MIME/condition/key/host/expiry", async () => {
    const result = await adapter().singlePut(
      identity,
      12,
      "image/jpeg",
      expiry,
    );
    for (const method of ["GET", "HEAD", "DELETE", "POST"])
      expect(
        await validSignature(result.put_url, method, result.required_headers),
      ).toBe(false);
    for (const headers of [
      { "content-type": "image/png", "if-none-match": "*" },
      { "content-type": "image/jpeg" },
    ])
      expect(await validSignature(result.put_url, "PUT", headers)).toBe(false);
    for (const change of [
      (url: URL) => {
        url.pathname = "/koko-dev-derived/other";
      },
      (url: URL) => {
        url.hostname = "untrusted.example";
      },
      (url: URL) => {
        url.searchParams.set("X-Amz-Expires", "600");
      },
    ]) {
      const url = new URL(result.put_url);
      change(url);
      expect(
        await validSignature(url.href, "PUT", result.required_headers),
      ).toBe(false);
    }
  });
  it("canonicalizes UUID case and accepts declared formats without an image allowlist", async () => {
    const result = await adapter().singlePut(
      { ...identity, assetId: identity.assetId.toUpperCase() },
      1,
      "application/octet-stream",
      expiry,
    );
    expect(new URL(result.put_url).pathname).toContain(identity.assetId);
    expect(result.required_headers["content-type"]).toBe(
      "application/octet-stream",
    );
  });
  it.each(["eventId", "postId", "assetId"])(
    "refuses caller paths in %s",
    async (key) => {
      await expect(
        adapter().singlePut(
          { ...identity, [key]: "../other?x=1" },
          12,
          "image/jpeg",
          expiry,
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    },
  );
  it.each([
    "",
    " ",
    " image/jpeg",
    "image/jpeg ",
    "image/jpeg\r\nX: canary",
    "a".repeat(256),
    "画像/jpeg",
  ])("invalid header %j", async (type) => {
    await expect(
      adapter().singlePut(identity, 12, type, expiry),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("requires a multipart plan for files above the operational single threshold", async () => {
    await expect(
      adapter().singlePut(identity, large, "image/jpeg", expiry),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it.each([
    "invalid",
    new Date(now - 1).toISOString(),
    new Date(now).toISOString(),
    new Date(now + 999).toISOString(),
    new Date(now + 901000).toISOString(),
  ])("rejects expired/invalid/excessive deadlines %s", async (end) => {
    await expect(
      adapter().singlePut(identity, 1, "image/jpeg", end),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("accepts the maximum and rounds sub-second expiry down, never extends it", async () => {
    const max = new Date(now + maxUploadSignatureSeconds * 1000).toISOString();
    const result = await adapter().singlePut(identity, 1, "image/jpeg", max);
    expect(new URL(result.put_url).searchParams.get("X-Amz-Expires")).toBe(
      "900",
    );
    const rounded = await adapter(() => now + 123).singlePut(
      identity,
      1,
      "image/jpeg",
      new Date(now + 300456).toISOString(),
    );
    expect(rounded.expires_at).toBe(expiry);
    expect(
      await validSignature(rounded.put_url, "PUT", rounded.required_headers),
    ).toBe(true);
  });
  it("refuses non-finite clocks and an already expired reusable deadline", async () => {
    await expect(
      adapter(() => NaN).singlePut(identity, 1, "image/jpeg", expiry),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      adapter(() => Date.parse(expiry)).singlePut(
        identity,
        1,
        "image/jpeg",
        expiry,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("explicit renewed deadlines produce a new signature, without pretending to revoke an older URL", async () => {
    const first = await adapter().singlePut(identity, 1, "image/jpeg", expiry);
    const second = await adapter(() => now + 100000).singlePut(
      identity,
      1,
      "image/jpeg",
      new Date(now + 400000).toISOString(),
    );
    expect(second.put_url).not.toBe(first.put_url);
    expect(
      await validSignature(first.put_url, "PUT", first.required_headers),
    ).toBe(true);
    expect(
      await validSignature(second.put_url, "PUT", second.required_headers),
    ).toBe(true);
  });
});

describe("multipart part signatures", () => {
  it("binds each PUT to its part and opaque provider ID with no header contract extension", async () => {
    const id = "opaque+/=!&partNumber=999?token%test";
    const result = await adapter().partPuts(
      identity,
      large,
      id,
      [9, 1, 2],
      expiry,
    );
    expect(result.map((part) => part.part_number)).toEqual([9, 1, 2]);
    for (const part of result) {
      const url = new URL(part.put_url);
      expect(url.searchParams.getAll("partNumber")).toEqual([
        String(part.part_number),
      ]);
      expect(url.searchParams.getAll("uploadId")).toEqual([id]);
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
      expect(await validSignature(part.put_url, "PUT", {})).toBe(true);
      url.searchParams.set("partNumber", "3");
      expect(await validSignature(url.href, "PUT", {})).toBe(false);
      const other = new URL(part.put_url);
      other.searchParams.set("uploadId", "other");
      expect(await validSignature(other.href, "PUT", {})).toBe(false);
      expect(await validSignature(part.put_url, "POST", {})).toBe(false);
    }
  });
  it("signs up to 100 requested parts and only up to the declared final part", async () => {
    const result = await adapter().partPuts(
      identity,
      maxR2ObjectBytes,
      "opaque",
      Array.from({ length: 100 }, (_, i) => i + 1),
      expiry,
    );
    expect(result).toHaveLength(100);
    await expect(
      adapter().partPuts(identity, large, "opaque", [10], expiry),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it.each(
    [
      [],
      [0],
      [-1],
      [1.5],
      [NaN],
      [1, 1],
      [10001],
      Array.from({ length: 101 }, (_, i) => i + 1),
    ].map((parts) => ({ parts })),
  )("rejects invalid part selection $parts", async ({ parts }) => {
    await expect(
      adapter().partPuts(identity, maxR2ObjectBytes, "opaque", parts, expiry),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it.each(["", "x\ncanary", " ", "x".repeat(2049)])(
    "rejects malformed provider ID %j",
    async (id) => {
      await expect(
        adapter().partPuts(identity, large, id, [1], expiry),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    },
  );
  it("refuses a single plan or expired part signature", async () => {
    await expect(
      adapter().partPuts(identity, 1, "opaque", [1], expiry),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      adapter().partPuts(
        identity,
        large,
        "opaque",
        [1],
        new Date(now).toISOString(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("credentials and provider failures", () => {
  it.each(Object.keys(credentials))(
    "fails closed when %s is missing or malformed",
    (key) => {
      for (const value of ["", "canary-secret/../?x=1"]) {
        expect(() =>
          createR2UploadAdapter(
            { ...credentials, [key]: value },
            env.ORIGINALS_BUCKET,
          ),
        ).toThrow("INTERNAL_ERROR");
      }
    },
  );
  it("does not log or include a provider exception, nor retry an ambiguous creation", async () => {
    const log = vi.spyOn(console, "error");
    const create = vi
      .fn()
      .mockRejectedValue(new Error("canary-secret SignedURL"));
    const provider = createR2UploadAdapter(credentials, {
      createMultipartUpload: create,
      resumeMultipartUpload: vi.fn(),
    });
    await expect(
      provider.beginMultipart(identity, large, "video/mp4"),
    ).rejects.toEqual(new R2UploadError("INTERNAL_ERROR"));
    expect(create).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });
  it("refuses small input before creating a provider multipart", async () => {
    const create = vi.fn();
    const provider = createR2UploadAdapter(credentials, {
      createMultipartUpload: create,
      resumeMultipartUpload: vi.fn(),
    });
    await expect(
      provider.beginMultipart(identity, 1, "image/jpeg"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(create).not.toHaveBeenCalled();
  });
  it("masks malformed provider results and abort errors", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ key: "other-key", uploadId: "opaque" });
    const abort = vi.fn().mockRejectedValue(new Error("canary-secret"));
    const resume = vi.fn().mockReturnValue({ abort });
    const provider = createR2UploadAdapter(credentials, {
      createMultipartUpload: create,
      resumeMultipartUpload: resume,
    });
    await expect(
      provider.beginMultipart(identity, large, "video/mp4"),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(provider.abortMultipart(identity, "opaque")).rejects.toEqual(
      new R2UploadError("INTERNAL_ERROR"),
    );
    expect(resume).toHaveBeenCalledWith(
      originalKey(identity.eventId, identity.postId, identity.assetId),
      "opaque",
    );
    expect(abort).toHaveBeenCalledTimes(1);
  });
});

describe("local R2 binding integration (not cloud/S3 acceptance)", () => {
  it("creates, resumes, signs and aborts a multipart without publishing an object", async () => {
    const unique = { ...identity, assetId: crypto.randomUUID() };
    const key = originalKey(unique.eventId, unique.postId, unique.assetId);
    const r2 = adapter();
    const created = await r2.beginMultipart(unique, large, "video/mp4");
    expect(created.mode).toBe("multipart");
    expect(created.partSizeBytes).toBe(8 * 1024 ** 2);
    const resumed = env.ORIGINALS_BUCKET.resumeMultipartUpload(
      key,
      created.providerUploadId,
    );
    try {
      const result = await resumed.uploadPart(1, new Uint8Array([1, 2, 3]));
      expect(result.partNumber).toBe(1);
      expect(result.etag).toEqual(expect.any(String));
      const signed = await r2.partPuts(
        unique,
        large,
        created.providerUploadId,
        [1],
        expiry,
      );
      expect(await validSignature(signed[0]!.put_url, "PUT", {})).toBe(true);
      expect(await env.ORIGINALS_BUCKET.head(key)).toBeNull();
      expect(await env.DERIVED_BUCKET.head(key)).toBeNull();
    } finally {
      await r2.abortMultipart(unique, created.providerUploadId);
    }
    await expect(resumed.uploadPart(1, new Uint8Array([4]))).rejects.toThrow();
    expect(await env.ORIGINALS_BUCKET.head(key)).toBeNull();
  });
});
