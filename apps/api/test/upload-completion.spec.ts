import { describe, expect, it, vi } from "vitest";
import { errors, originalKey } from "@koko/contract";
import {
  handleUploadCompletion,
  type CompletionEnv,
} from "../src/upload-completion";
import {
  createCsrfToken,
  readAccountAuthentication,
} from "../src/account-auth";
import worker from "../src/index";
import { multipartEtag } from "../src/r2-completion";
const eventId = "11111111-1111-4111-8111-111111111111",
  userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  postId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  assetId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  uploadId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const key = originalKey(eventId, postId, assetId);
const prepared = {
  code: "prepared",
  post_id: postId,
  upload_id: uploadId,
  asset_id: assetId,
  object_key: key,
  mode: "single",
  provider_upload_id: null,
  file_size_bytes: 123,
  post_version: 1,
  parts: [],
};
const ack = {
  code: "completed",
  post: {
    id: postId,
    event_id: eventId,
    status: "uploaded",
    version: 2,
    created_at: "2026-10-05T00:00:00Z",
  },
};
function request(
  body: unknown = { upload_id: uploadId },
  headers: Record<string, string> = {},
) {
  return new Request(`https://api.example.test/posts/${postId}/complete`, {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-token",
      "X-Event-ID": eventId,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
function fixture(results: unknown[] = [prepared, ack]) {
  const head = vi.fn(
    async () =>
      ({
        key,
        size: 123,
        version: "fixture-version",
        etag: "a".repeat(32),
      }) as R2Object,
  );
  const resumeMultipartUpload = vi.fn();
  const env: CompletionEnv = {
    KOKO_UPLOADS_ENABLED: "true",
    SUPABASE_URL: "https://fixture.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SECRET_KEY: "sb_secret_fixture",
    ORIGINALS_BUCKET: { head, resumeMultipartUpload },
  };
  const calls: Record<string, unknown>[] = [];
  const fetcher = vi.fn(
    async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        target instanceof Request ? target.url : String(target),
      );
      expect(url.origin).toBe("https://fixture.supabase.co");
      expect(init?.redirect).toBe("manual");
      expect(init?.cache).toBe("no-store");
      if (url.pathname === "/auth/v1/user")
        return Response.json({
          id: userId,
          app_metadata: { provider: "google", providers: ["google"] },
        });
      expect(url.pathname).toBe("/rest/v1/rpc/complete_upload");
      expect(new Headers(init?.headers).get("apikey")).toBe(
        env.SUPABASE_SECRET_KEY,
      );
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        p_event_id: eventId,
        p_user_id: userId,
        p_post_id: postId,
        p_upload_id: uploadId,
      });
      calls.push(body);
      const value = results.shift();
      if (value instanceof Error) throw value;
      return value instanceof Response ? value : Response.json(value);
    },
  ) as typeof fetch;
  return { env, fetcher, head, resumeMultipartUpload, calls };
}
async function errorCode(response: Response, code: keyof typeof errors) {
  expect(response.status).toBe(errors[code].status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ code });
}
describe("upload complete HTTP", () => {
  it("enabled Worker routing reaches authentication without a credential", async () => {
    const f = fixture();
    const req = request();
    req.headers.delete("authorization");
    await errorCode(
      await worker.fetch(
        req as Request<unknown, IncomingRequestCfProperties>,
        f.env as Env,
      ),
      "AUTH_REQUIRED",
    );
  });
  it("multipart accepts JSONB key ordering and canonicalizes caller ETags", async () => {
    const parts = Array.from({ length: 9 }, (_, i) => ({
      part_number: i + 1,
      etag: "a".repeat(32),
    }));
    const f = fixture([
      {
        ...prepared,
        mode: "multipart",
        provider_upload_id: "provider",
        file_size_bytes: 67108865,
        parts: parts.map((p) => ({ etag: p.etag, part_number: p.part_number })),
      },
      ack,
    ]);
    f.head.mockResolvedValueOnce({
      key,
      size: 67108865,
      version: "fixture-version",
      etag: await multipartEtag(parts),
    } as R2Object);
    const body = {
      upload_id: uploadId,
      parts: parts
        .slice()
        .reverse()
        .map((p) => ({ ...p, etag: '"' + p.etag.toUpperCase() + '"' })),
    };
    expect(
      (await handleUploadCompletion(request(body), f.env, f.fetcher)).status,
    ).toBe(202);
    expect(f.calls[0]?.p_input).toEqual({ parts });
    expect(f.resumeMultipartUpload).not.toHaveBeenCalled();
  });
  it("is disabled by default, routed, and POST only", async () => {
    const f = fixture();
    delete f.env.KOKO_UPLOADS_ENABLED;
    await errorCode(
      await handleUploadCompletion(request(), f.env, f.fetcher),
      "NOT_FOUND",
    );
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(
      (
        await worker.fetch(
          request() as Request<unknown, IncomingRequestCfProperties>,
          f.env as Env,
        )
      ).status,
    ).toBe(404);
    f.env.KOKO_UPLOADS_ENABLED = "true";
    const response = await handleUploadCompletion(
      new Request(request().url),
      f.env,
      f.fetcher,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
  it("only trusted HEAD metadata reaches commit, and only public receipt escapes", async () => {
    const f = fixture([
      prepared,
      { ...ack, private: "not-public", post: { ...ack.post, object_key: key } },
    ]);
    const response = await handleUploadCompletion(request(), f.env, f.fetcher);
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(ack.post);
    expect(f.calls[0]?.p_action).toBe("prepare");
    expect(f.calls[1]).toMatchObject({
      p_action: "commit",
      p_input: {
        parts: [],
        post_version: 1,
        observation: {
          object_key: key,
          size: 123,
          version: "fixture-version",
          etag: "a".repeat(32),
        },
      },
    });
    expect(f.resumeMultipartUpload).not.toHaveBeenCalled();
  });
  it("completed retry returns receipt without touching R2/committing again", async () => {
    const f = fixture([ack]);
    expect(
      (await handleUploadCompletion(request(), f.env, f.fetcher)).status,
    ).toBe(202);
    expect(f.head).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(1);
  });
  it.each([
    {},
    null,
    [],
    { upload_id: "bad" },
    { upload_id: uploadId, object_key: key },
    { upload_id: uploadId, parts: [] },
    { upload_id: uploadId, parts: null },
    { upload_id: uploadId, parts: [{ part_number: 1, etag: "bad" }] },
  ])("rejects malformed input without DB/R2", async (body) => {
    const f = fixture();
    await errorCode(
      await handleUploadCompletion(request(body), f.env, f.fetcher),
      "INVALID_INPUT",
    );
    expect(f.calls).toHaveLength(0);
    expect(f.head).not.toHaveBeenCalled();
  });
  it("bounds streamed JSON and rejects wrong content type/invalid UTF8", async () => {
    for (const req of [
      request({ upload_id: uploadId }, { "content-type": "text/plain" }),
      request({ upload_id: uploadId }, { "content-length": "1048577" }),
      new Request(request().url, {
        method: "POST",
        headers: request().headers,
        body: new Uint8Array([0xff]),
      }),
      request({ upload_id: uploadId, extra: "x".repeat(1048576) }),
    ]) {
      const f = fixture();
      await errorCode(
        await handleUploadCompletion(req, f.env, f.fetcher),
        "INVALID_INPUT",
      );
      expect(f.calls).toHaveLength(0);
    }
  });
  it.each([
    "FORBIDDEN",
    "NOT_FOUND",
    "CONSENT_REQUIRED",
    "ACCOUNT_BANNED",
    "EVENT_CLOSED",
    "PUBLICATION_STOPPED",
    "THEME_UNAVAILABLE",
    "STATE_CONFLICT",
    "IDEMPOTENCY_CONFLICT",
  ] as const)("preserves guard %s and never contacts R2", async (code) => {
    const f = fixture([{ code }]);
    await errorCode(
      await handleUploadCompletion(request(), f.env, f.fetcher),
      code,
    );
    expect(f.head).not.toHaveBeenCalled();
  });
  it.each([
    { ...prepared, post_id: assetId },
    { ...prepared, upload_id: assetId },
    { ...prepared, object_key: "other" },
    { ...prepared, mode: "multipart" },
    { ...prepared, file_size_bytes: -1 },
    { ...prepared, parts: [{ part_number: 1, etag: "a".repeat(32) }] },
    { ...ack, post: { ...ack.post, event_id: assetId } },
    new Response("private upstream detail", { status: 500 }),
    new Error("private secret"),
    { code: "secret-unknown" },
  ])("closes malformed/failed upstream safely", async (result) => {
    const f = fixture([result]);
    const response = await handleUploadCompletion(request(), f.env, f.fetcher);
    await errorCode(response, "INTERNAL_ERROR");
    expect(f.head).not.toHaveBeenCalled();
  });
  it("missing original cannot commit", async () => {
    const f = fixture();
    f.head.mockResolvedValueOnce(null as unknown as R2Object);
    await errorCode(
      await handleUploadCompletion(request(), f.env, f.fetcher),
      "UPLOAD_INCOMPLETE",
    );
    expect(f.calls).toHaveLength(1);
  });
  it("a policy changed while HEAD runs still rejects at commit", async () => {
    const f = fixture([prepared, { code: "ACCOUNT_BANNED" }]);
    await errorCode(
      await handleUploadCompletion(request(), f.env, f.fetcher),
      "ACCOUNT_BANNED",
    );
    expect(f.head).toHaveBeenCalledTimes(1);
  });
  it("lost commit response retries via saved acknowledgement", async () => {
    const f = fixture([prepared, new Error("lost"), ack]);
    await errorCode(
      await handleUploadCompletion(request(), f.env, f.fetcher),
      "INTERNAL_ERROR",
    );
    expect(
      (await handleUploadCompletion(request(), f.env, f.fetcher)).status,
    ).toBe(202);
    expect(f.head).toHaveBeenCalledTimes(1);
  });
  it("requires Google identity and valid Cookie CSRF before DB", async () => {
    const f = fixture();
    f.env.KOKO_WEB_ORIGIN = "https://web.example.test";
    f.env.KOKO_CSRF_SECRET = "d".repeat(64);
    const req = request();
    req.headers.delete("authorization");
    req.headers.set("cookie", "__Host-koko_session=fixture-token");
    req.headers.set("origin", f.env.KOKO_WEB_ORIGIN);
    req.headers.set("sec-fetch-site", "same-origin");
    await errorCode(
      await handleUploadCompletion(req.clone(), f.env, f.fetcher),
      "FORBIDDEN",
    );
    expect(f.calls).toHaveLength(0);
    const auth = readAccountAuthentication(req, f.env);
    if (!auth.ok || auth.authentication.mode !== "cookie")
      throw new Error("fixture auth");
    req.headers.set(
      "X-CSRF-Token",
      await createCsrfToken(auth.authentication, eventId),
    );
    expect((await handleUploadCompletion(req, f.env, f.fetcher)).status).toBe(
      202,
    );
  });
});
