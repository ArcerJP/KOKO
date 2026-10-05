import { afterEach, describe, expect, it, vi } from "vitest";
import { errors, originalKey } from "@koko/contract";
import {
  createCsrfToken,
  readAccountAuthentication,
} from "../src/account-auth";
import { handleUploads, type UploadEnv } from "../src/uploads";
import worker from "../src/index";

const eventId = "11111111-1111-4111-8111-111111111111";
const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const postId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const assetId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const uploadId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const input = {
  client_request_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  kind: "photo",
  content_type: "image/jpeg",
  file_size_bytes: 123,
  original_scope: "photo_file",
};
const multipart = {
  ...input,
  kind: "video",
  file_size_bytes: 67108865,
  original_scope: "full_video_fallback",
};
const path = (action: string) => `/uploads/${uploadId}/${action}`;
function request(
  route = "/uploads",
  body: unknown = input,
  headers: Record<string, string> = {},
) {
  return new Request(`https://api.example.test${route}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer synthetic-token",
      "X-Event-ID": eventId,
      "content-type": "application/json",
      ...headers,
    },
    ...(body === undefined || route.endsWith("refresh")
      ? {}
      : { body: JSON.stringify(body) }),
  });
}
function session(overrides: Record<string, unknown> = {}) {
  return {
    code: "ready",
    post_id: postId,
    asset_id: assetId,
    upload_id: uploadId,
    mode: "single",
    provider_upload_id: null,
    expires_at: new Date(
      Math.floor(Date.now() / 1000) * 1000 + 800000,
    ).toISOString(),
    object_key: originalKey(eventId, postId, assetId),
    request: { ...input, theme_id: null },
    ...overrides,
  };
}
function fixture(results: unknown[] = [session()]) {
  const abort = vi.fn();
  const create = vi.fn(async (key: string) => ({
    key,
    uploadId: "synthetic-provider-id",
    abort,
    uploadPart: vi.fn(),
    complete: vi.fn(),
  }));
  const resume = vi.fn();
  const env: UploadEnv = {
    KOKO_UPLOADS_ENABLED: "true",
    SUPABASE_URL: "https://fixture.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SECRET_KEY: "sb_secret_fixture",
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_ACCESS_KEY_ID: "b".repeat(32),
    R2_SECRET_ACCESS_KEY: "c".repeat(64),
    ORIGINALS_BUCKET: {
      createMultipartUpload: create,
      resumeMultipartUpload: resume,
    },
  };
  const calls: {
    url: URL;
    init: RequestInit | undefined;
    body?: Record<string, unknown>;
  }[] = [];
  const fetcher = vi.fn(
    async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        target instanceof Request ? target.url : String(target),
      );
      expect(url.origin).toBe("https://fixture.supabase.co");
      expect(init?.redirect).toBe("manual");
      expect(init?.cache).toBe("no-store");
      const call = {
        url,
        init,
        ...(typeof init?.body === "string"
          ? { body: JSON.parse(init.body) as Record<string, unknown> }
          : {}),
      };
      calls.push(call);
      if (url.pathname === "/auth/v1/user")
        return Response.json({
          id: userId,
          app_metadata: { provider: "google", providers: ["google"] },
        });
      expect(url.pathname).toBe("/rest/v1/rpc/manage_upload_session");
      expect(new Headers(init?.headers).get("apikey")).toBe(
        env.SUPABASE_SECRET_KEY,
      );
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(call.body?.p_user_id).toBe(userId);
      expect(call.body?.p_event_id).toBe(eventId);
      const next = results.shift();
      if (next instanceof Error) throw next;
      if (
        next &&
        typeof next === "object" &&
        "code" in next &&
        next.code === "provision"
      ) {
        const rpcInput = call.body?.p_input as Record<string, unknown>;
        return Response.json({
          provisioning_attempt: rpcInput.attempt_id,
          provisioning_locked_until: new Date(
            Date.now() + 120000,
          ).toISOString(),
          ...next,
        });
      }
      return next instanceof Response ? next : Response.json(next);
    },
  ) as typeof fetch;
  return { env, fetcher, calls, create, abort, resume };
}
afterEach(() => vi.useRealTimers());
async function code(response: Response, expected: keyof typeof errors) {
  expect(response.status).toBe(errors[expected].status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body = await response.json();
  expect(body).toMatchObject({
    code: expected,
    request_id: expect.any(String),
  });
  expect(
    Object.keys(body as object).every((k) =>
      ["code", "request_id", "retry_after_seconds"].includes(k),
    ),
  ).toBe(true);
  return body;
}

describe("upload HTTP admission and session orchestration", () => {
  it.each([undefined, "false", "TRUE", "1"])(
    "flag %s leaves routes disabled and does not contact upstream",
    async (flag) => {
      const f = fixture();
      if (flag === undefined) delete f.env.KOKO_UPLOADS_ENABLED;
      else f.env.KOKO_UPLOADS_ENABLED = flag;
      for (const route of ["/uploads", path("refresh"), path("parts")])
        expect(
          (await handleUploads(request(route), f.env, f.fetcher)).status,
        ).toBe(404);
      expect(f.calls).toHaveLength(0);
      expect(f.create).not.toHaveBeenCalled();
    },
  );
  it("worker routes enabled requests through the authentication gate", async () => {
    const f = fixture();
    const req = request("/uploads", input, { Authorization: "" });
    const result = await worker.fetch(
      req as Request<unknown, IncomingRequestCfProperties>,
      f.env as unknown as Env,
    );
    await code(result, "AUTH_REQUIRED");
  });
  it.each(["GET", "PUT", "DELETE", "OPTIONS"])(
    "rejects method %s",
    async (method) => {
      const f = fixture();
      const result = await handleUploads(
        new Request("https://api.example.test/uploads", { method }),
        f.env,
        f.fetcher,
      );
      expect(result.status).toBe(405);
      expect(result.headers.get("allow")).toBe("POST");
      expect(f.calls).toHaveLength(0);
    },
  );
  it("single ticket only exposes the contracted fields and create-only signed PUT", async () => {
    const f = fixture();
    const response = await handleUploads(request(), f.env, f.fetcher);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "expires_at",
      "mode",
      "post_id",
      "put_url",
      "required_headers",
      "upload_id",
    ]);
    expect(body.required_headers).toEqual({
      "content-type": "image/jpeg",
      "if-none-match": "*",
    });
    const signed = new URL(String(body.put_url));
    expect(signed.hostname).toBe(`${"a".repeat(32)}.r2.cloudflarestorage.com`);
    expect(signed.pathname).toBe(
      `/koko-dev-originals/${originalKey(eventId, postId, assetId)}`,
    );
    expect(f.create).not.toHaveBeenCalled();
    expect(f.calls[1]?.body?.p_action).toBe("open");
    expect(f.calls[1]?.body?.p_input).toMatchObject({
      request: { ...input, theme_id: null },
      attempt_id: expect.any(String),
    });
  });
  it("multipart winner creates once, persists opaque provider id, reauthorizes, and hides internal values", async () => {
    const pending = session({
      code: "provision",
      mode: "multipart",
      request: { ...multipart, theme_id: null },
    });
    const ready = {
      ...pending,
      code: "ready",
      provider_upload_id: "synthetic-provider-id",
    };
    const f = fixture([pending, ready]);
    const response = await handleUploads(
      request("/uploads", multipart),
      f.env,
      f.fetcher,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      post_id: postId,
      upload_id: uploadId,
      mode: "multipart",
      expires_at: ready.expires_at,
      part_size_bytes: 8388608,
    });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.calls[2]?.body?.p_action).toBe("attach");
    const first = f.calls[1]?.body?.p_input as Record<string, unknown>;
    const second = f.calls[2]?.body?.p_input as Record<string, unknown>;
    expect(second).toEqual({
      upload_id: uploadId,
      attempt_id: first.attempt_id,
      provider_upload_id: "synthetic-provider-id",
    });
    expect(f.abort).not.toHaveBeenCalled();
  });
  it("ready retry/refresh reuse multipart without a second provider create", async () => {
    const result = session({
      mode: "multipart",
      provider_upload_id: "synthetic-provider-id",
      request: { ...multipart, theme_id: null },
    });
    const f = fixture([result, result]);
    expect(
      (await handleUploads(request("/uploads", multipart), f.env, f.fetcher))
        .status,
    ).toBe(200);
    expect(
      (await handleUploads(request(path("refresh")), f.env, f.fetcher)).status,
    ).toBe(200);
    expect(f.create).not.toHaveBeenCalled();
  });
  it("a later explicit open recovers an unknown create only after DB grants a new generation", async () => {
    const pending = session({
      code: "provision",
      mode: "multipart",
      request: { ...multipart, theme_id: null },
    });
    const ready = {
      ...pending,
      code: "ready",
      provider_upload_id: "synthetic-provider-id",
    };
    const f = fixture([
      pending,
      { code: "UPLOAD_INCOMPLETE" },
      pending,
      ready,
      ready,
    ]);
    f.create.mockRejectedValueOnce(new Error("unknown provider outcome"));
    await code(
      await handleUploads(request("/uploads", multipart), f.env, f.fetcher),
      "INTERNAL_ERROR",
    );
    await code(
      await handleUploads(request("/uploads", multipart), f.env, f.fetcher),
      "UPLOAD_INCOMPLETE",
    );
    expect(f.create).toHaveBeenCalledTimes(1);
    const recovered = await handleUploads(
      request("/uploads", multipart),
      f.env,
      f.fetcher,
    );
    expect(recovered.status).toBe(200);
    expect(Object.keys(await recovered.json()).sort()).toEqual([
      "expires_at",
      "mode",
      "part_size_bytes",
      "post_id",
      "upload_id",
    ]);
    expect(
      (await handleUploads(request("/uploads", multipart), f.env, f.fetcher))
        .status,
    ).toBe(200);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.abort).not.toHaveBeenCalled();
    const opens = f.calls.filter((call) => call.body?.p_action === "open");
    expect(
      new Set(
        opens.map(
          (call) => (call.body?.p_input as Record<string, unknown>).attempt_id,
        ),
      ).size,
    ).toBe(opens.length);
  });
  it("lost attach response followed by ready never recreates or aborts the committed provider", async () => {
    const pending = session({
      code: "provision",
      mode: "multipart",
      request: { ...multipart, theme_id: null },
    });
    const ready = {
      ...pending,
      code: "ready",
      provider_upload_id: "synthetic-provider-id",
    };
    const f = fixture([pending, new Error("unknown attach response"), ready]);
    await code(
      await handleUploads(request("/uploads", multipart), f.env, f.fetcher),
      "INTERNAL_ERROR",
    );
    expect(
      (await handleUploads(request("/uploads", multipart), f.env, f.fetcher))
        .status,
    ).toBe(200);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.abort).not.toHaveBeenCalled();
  });
  it.each([
    { provisioning_attempt: "00000000-0000-4000-8000-000000000001" },
    { provisioning_attempt: null },
    { provisioning_locked_until: null },
    { provisioning_locked_until: "invalid" },
    { provisioning_locked_until: "2000-01-01T00:00:00Z" },
    { provisioning_locked_until: "2099-01-01T00:00:00Z" },
  ])(
    "malformed or expired provisioning lease %# cannot create",
    async (patch) => {
      const f = fixture([
        session({
          code: "provision",
          mode: "multipart",
          request: { ...multipart, theme_id: null },
          ...patch,
        }),
      ]);
      await code(
        await handleUploads(request("/uploads", multipart), f.env, f.fetcher),
        "INTERNAL_ERROR",
      );
      expect(f.create).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(2);
    },
  );
  it("provider result arriving after lease expiry cannot attach, ticket or abort", async () => {
    vi.useFakeTimers();
    const f = fixture([
      session({
        code: "provision",
        mode: "multipart",
        request: { ...multipart, theme_id: null },
      }),
    ]);
    const original = f.create.getMockImplementation()!;
    let finish!: () => Promise<void>;
    f.create.mockImplementationOnce(
      (key) =>
        new Promise((resolve) => {
          finish = async () => resolve(await original(key));
        }),
    );
    const pending = handleUploads(
      request("/uploads", multipart),
      f.env,
      f.fetcher,
    );
    await vi.advanceTimersByTimeAsync(120001);
    await code(await pending, "UPLOAD_INCOMPLETE");
    await finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(
      f.calls.filter((call) => call.body?.p_action === "attach"),
    ).toHaveLength(0);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.abort).not.toHaveBeenCalled();
  });
  it("DB rejects an expired/replaced generation attach without granting a ticket or recreating", async () => {
    const f = fixture([
      session({
        code: "provision",
        mode: "multipart",
        request: { ...multipart, theme_id: null },
      }),
      { code: "STATE_CONFLICT" },
    ]);
    await code(
      await handleUploads(request("/uploads", multipart), f.env, f.fetcher),
      "STATE_CONFLICT",
    );
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.resume).not.toHaveBeenCalled();
  });
  it("parts only grants requested numbers and rejects numbers beyond the planned count", async () => {
    const result = session({
      mode: "multipart",
      provider_upload_id: "synthetic-provider-id",
      request: { ...multipart, theme_id: null },
    });
    const f = fixture([result, result]);
    const response = await handleUploads(
      request(path("parts"), { part_numbers: [1, 9] }),
      f.env,
      f.fetcher,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      parts: { part_number: number; put_url: string }[];
    };
    expect(body.parts.map((p) => p.part_number)).toEqual([1, 9]);
    for (const p of body.parts) {
      const url = new URL(p.put_url);
      expect(url.searchParams.get("partNumber")).toBe(String(p.part_number));
      expect(url.searchParams.get("uploadId")).toBe("synthetic-provider-id");
    }
    await code(
      await handleUploads(
        request(path("parts"), { part_numbers: [10] }),
        f.env,
        f.fetcher,
      ),
      "INVALID_INPUT",
    );
    expect(f.create).not.toHaveBeenCalled();
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
    "UPLOAD_EXPIRED",
    "UPLOAD_INCOMPLETE",
    "PROVIDER_LIMIT",
    "INTERNAL_ERROR",
  ] as const)("DB %s is bounded and never grants a URL", async (expected) => {
    const f = fixture([
      { code: expected, secret: "never return upstream detail" },
    ]);
    await code(await handleUploads(request(), f.env, f.fetcher), expected);
    expect(f.create).not.toHaveBeenCalled();
  });
  it("rate limit includes only validated retry seconds", async () => {
    const f = fixture([
      { code: "RATE_LIMITED", retry_after_seconds: 12 },
      { code: "RATE_LIMITED", retry_after_seconds: 0 },
    ]);
    expect(
      await code(
        await handleUploads(request(), f.env, f.fetcher),
        "RATE_LIMITED",
      ),
    ).toMatchObject({ retry_after_seconds: 12 });
    await code(
      await handleUploads(request(), f.env, f.fetcher),
      "INTERNAL_ERROR",
    );
  });
  it.each([
    null,
    {},
    [],
    { ...input, user_id: userId },
    { ...input, content_type: " text/plain" },
    { ...input, content_type: "日本語" },
    { ...input, content_type: "a\nb" },
    { ...input, file_size_bytes: 0 },
    { ...input, file_size_bytes: 1.1 },
    { ...input, kind: "audio" },
    { ...input, theme_id: "bad" },
    { ...input, original_scope: "client_trimmed" },
  ])("rejects malformed upload request %# before DB/provider", async (body) => {
    const f = fixture();
    await code(
      await handleUploads(request("/uploads", body), f.env, f.fetcher),
      "INVALID_INPUT",
    );
    expect(f.calls).toHaveLength(1);
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each([
    [],
    [0],
    [1, 1],
    [10001],
    Array.from({ length: 101 }, (_, i) => i + 1),
  ])("rejects malformed part numbers %# before DB", async (parts) => {
    const f = fixture();
    await code(
      await handleUploads(
        request(path("parts"), { part_numbers: parts }),
        f.env,
        f.fetcher,
      ),
      "INVALID_INPUT",
    );
    expect(f.calls).toHaveLength(1);
  });
  it("enforces provider size boundary before DB", async () => {
    const f = fixture();
    await code(
      await handleUploads(
        request("/uploads", { ...input, file_size_bytes: 5 * 1024 ** 4 }),
        f.env,
        f.fetcher,
      ),
      "PROVIDER_LIMIT",
    );
    expect(f.calls).toHaveLength(1);
  });
  it.each(["json", "oversize", "utf8", "type"])(
    "bounds %s body",
    async (kind) => {
      const f = fixture();
      const req = new Request("https://api.example.test/uploads", {
        method: "POST",
        headers: {
          Authorization: "Bearer synthetic-token",
          "X-Event-ID": eventId,
          "content-type": kind === "type" ? "text/plain" : "application/json",
        },
        body:
          kind === "utf8"
            ? new Uint8Array([0xff])
            : kind === "oversize"
              ? " ".repeat(4097)
              : "{",
      });
      await code(await handleUploads(req, f.env, f.fetcher), "INVALID_INPUT");
      expect(f.calls).toHaveLength(1);
    },
  );
  it.each([
    { code: "unknown" },
    { post_id: "bad" },
    { object_key: "attacker-key" },
    { mode: "multipart" },
    { provider_upload_id: "unexpected" },
    { expires_at: "invalid" },
    { expires_at: "2000-01-01T00:00:00Z" },
    { expires_at: "2099-01-01T00:00:00Z" },
    { request: { ...input, file_size_bytes: 124 } },
    { request: { ...input, file_size_bytes: 1e20 } },
  ])("rejects malformed or mismatched DB success %#", async (overrides) => {
    const f = fixture([session(overrides)]);
    await code(
      await handleUploads(request(), f.env, f.fetcher),
      "INTERNAL_ERROR",
    );
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each([
    new Error("sensitive provider/db detail"),
    new Response(null, {
      status: 302,
      headers: { location: "https://evil.example" },
    }),
    { code: "INTERNAL_ERROR" },
  ])(
    "ambiguous attach %# never aborts a potentially committed winner",
    async (result) => {
      const f = fixture([
        session({
          code: "provision",
          mode: "multipart",
          request: { ...multipart, theme_id: null },
        }),
        result,
      ]);
      await code(
        await handleUploads(request("/uploads", multipart), f.env, f.fetcher),
        "INTERNAL_ERROR",
      );
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.abort).not.toHaveBeenCalled();
      expect(f.resume).not.toHaveBeenCalled();
    },
  );
  it("provider creation failure is sanitized and not retried or attached", async () => {
    const f = fixture([
      session({
        code: "provision",
        mode: "multipart",
        request: { ...multipart, theme_id: null },
      }),
    ]);
    f.create.mockRejectedValue(new Error("secret"));
    await code(
      await handleUploads(request("/uploads", multipart), f.env, f.fetcher),
      "INTERNAL_ERROR",
    );
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveLength(2);
  });
  it("guard changed during provisioning prevents a ticket and never blind-aborts", async () => {
    const f = fixture([
      session({
        code: "provision",
        mode: "multipart",
        request: { ...multipart, theme_id: null },
      }),
      { code: "ACCOUNT_BANNED" },
    ]);
    await code(
      await handleUploads(request("/uploads", multipart), f.env, f.fetcher),
      "ACCOUNT_BANNED",
    );
    expect(f.abort).not.toHaveBeenCalled();
  });
  it("missing signing configuration fails before DB writes", async () => {
    const f = fixture();
    delete f.env.R2_SECRET_ACCESS_KEY;
    await code(
      await handleUploads(request(), f.env, f.fetcher),
      "INTERNAL_ERROR",
    );
    expect(f.calls).toHaveLength(1);
  });
  it.each([401, 403, 302, 500])(
    "Auth status %s cannot reach DB",
    async (status) => {
      const f = fixture();
      const fetcher = vi.fn(
        async () => new Response(null, { status }),
      ) as typeof fetch;
      await code(
        await handleUploads(request(), f.env, fetcher),
        status === 401 || status === 403 ? "AUTH_REQUIRED" : "INTERNAL_ERROR",
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("non-Google identity cannot reach DB", async () => {
    const f = fixture();
    const fetcher = vi.fn(async () =>
      Response.json({
        id: userId,
        app_metadata: { provider: "email", providers: ["email"] },
      }),
    ) as typeof fetch;
    await code(await handleUploads(request(), f.env, fetcher), "FORBIDDEN");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("Cookie upload requires same-origin and a valid event/session-bound CSRF token", async () => {
    const f = fixture();
    f.env.KOKO_WEB_ORIGIN = "https://web.example.test";
    f.env.KOKO_CSRF_SECRET = "d".repeat(64);
    function cookieRequest(origin = "https://web.example.test", csrf?: string) {
      const req = request();
      req.headers.delete("Authorization");
      req.headers.set("Cookie", "__Host-koko_session=synthetic-cookie");
      req.headers.set("Origin", origin);
      req.headers.set("Sec-Fetch-Site", "same-origin");
      if (csrf) req.headers.set("X-CSRF-Token", csrf);
      return req;
    }
    await code(
      await handleUploads(cookieRequest(), f.env, f.fetcher),
      "FORBIDDEN",
    );
    const auth = readAccountAuthentication(cookieRequest(), f.env);
    if (!auth.ok || auth.authentication.mode !== "cookie")
      throw new Error("fixture auth");
    const csrf = await createCsrfToken(auth.authentication, eventId);
    await code(
      await handleUploads(
        cookieRequest("https://evil.example", csrf),
        f.env,
        f.fetcher,
      ),
      "FORBIDDEN",
    );
    expect(f.calls).toHaveLength(0);
    expect(
      (
        await handleUploads(
          cookieRequest("https://web.example.test", csrf),
          f.env,
          f.fetcher,
        )
      ).status,
    ).toBe(200);
  });
});
