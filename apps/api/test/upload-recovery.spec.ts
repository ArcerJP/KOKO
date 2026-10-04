import { expect, it, vi } from "vitest";
import { originalKey } from "@koko/contract";
import {
  handleUploadRecoveryQueue,
  handleUploadRecoveryScheduled,
  recoveryCron,
  type RecoveryEnv,
} from "../src/upload-recovery";
import { multipartEtag } from "../src/r2-completion";
import worker from "../src/index";

const eventId = "11111111-1111-4111-8111-111111111111",
  postId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  assetId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  uploadId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const key = originalKey(eventId, postId, assetId),
  account = "a".repeat(32);
const prepared = {
  code: "prepared",
  post_id: postId,
  asset_id: assetId,
  upload_id: uploadId,
  object_key: key,
  mode: "single",
  provider_upload_id: null,
  file_size_bytes: 123,
  parts: [],
  post_version: 1,
};
const receipt = {
  code: "completed",
  post: {
    id: postId,
    event_id: eventId,
    status: "uploaded",
    version: 2,
    created_at: "2026-10-05T00:00:00Z",
  },
};
const body = {
  account,
  bucket: "koko-dev-originals",
  action: "PutObject",
  object: { key, size: 999999, eTag: "untrusted" },
};
const item = { event_id: eventId, post_id: postId, asset_id: assetId };
const candidates = { code: "candidates", items: [item] };
function fixture(results: unknown[] = [prepared, receipt]) {
  const head = vi.fn(
    async (): Promise<R2Object | null> =>
      ({
        key,
        size: 123,
        etag: "a".repeat(32),
        version: "fixture-version",
      }) as R2Object,
  );
  const resumeMultipartUpload = vi.fn();
  const env: RecoveryEnv = {
    KOKO_UPLOADS_ENABLED: "true",
    KOKO_UPLOAD_RECOVERY_ENABLED: "true",
    KOKO_UPLOAD_RECOVERY_QUEUE: "fixture-recovery",
    R2_ACCOUNT_ID: account,
    SUPABASE_URL: "https://fixture.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SECRET_KEY: "sb_secret_fixture",
    ORIGINALS_BUCKET: { head, resumeMultipartUpload },
  };
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(
    async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(target));
      expect(url.origin).toBe("https://fixture.supabase.co");
      expect([
        "/rest/v1/rpc/recover_upload",
        "/rest/v1/rpc/claim_upload_recovery",
      ]).toContain(url.pathname);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(init?.cache).toBe("no-store");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get("apikey")).toBe("sb_secret_fixture");
      expect(headers.get("authorization")).toBeNull();
      calls.push({ name: url.pathname, input: JSON.parse(String(init?.body)) });
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result instanceof Response ? result : Response.json(result);
    },
  ) as typeof fetch;
  return { env, head, resumeMultipartUpload, fetcher, calls };
}
function batch(bodies: unknown[] = [body], queue = "fixture-recovery") {
  const messages = bodies.map((value, i) => ({
    id: String(i),
    timestamp: new Date(),
    body: value,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  return {
    queue,
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}
const run = (f: ReturnType<typeof fixture>, b = batch()) =>
  handleUploadRecoveryQueue(b, f.env, f.fetcher);
const scan = (f: ReturnType<typeof fixture>) =>
  handleUploadRecoveryScheduled({ cron: recoveryCron }, f.env, f.fetcher);

it("uses only DB-derived identity/parts and HEAD observation, not notification metadata", async () => {
  const f = fixture(),
    b = batch();
  expect(await run(f, b)).toEqual({
    accepted: 1,
    ignored: 0,
    deferred: 0,
    retry: 0,
  });
  expect(f.calls[0]?.input).toEqual({
    p_event_id: eventId,
    p_post_id: postId,
    p_asset_id: assetId,
    p_action: "prepare",
    p_input: {},
  });
  expect(f.calls[1]?.input.p_input).toEqual({
    post_version: 1,
    observation: {
      object_key: key,
      size: 123,
      etag: "a".repeat(32),
      version: "fixture-version",
    },
  });
  expect(f.head).toHaveBeenCalledExactlyOnceWith(key);
  expect(f.resumeMultipartUpload).not.toHaveBeenCalled();
  expect(b.messages[0]?.ack).toHaveBeenCalledOnce();
  expect(b.messages[0]?.retry).not.toHaveBeenCalled();
});
it("duplicate completion receipt ACKs without HEAD or additional commit", async () => {
  const f = fixture([receipt, receipt]),
    b = batch([body, body]);
  expect((await run(f, b)).accepted).toBe(2);
  expect(f.head).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(2);
});
it.each([
  null,
  "json-string",
  {},
  { ...body, account: "b".repeat(32) },
  { ...body, bucket: "koko-dev-delivery" },
  { ...body, action: "CopyObject" },
  { ...body, action: "DeleteObject" },
  ...[
    "../object",
    key.toUpperCase(),
    key + "/",
    key + "\n",
    key.replace("events/", "events%2F"),
    "https://evil.test/" + key,
    key.replace(assetId, "not-a-uuid"),
  ].map((key) => ({ ...body, object: { key } })),
])(
  "ignores invalid/unrelated hint %# without any upstream access",
  async (input) => {
    const f = fixture(),
      b = batch([input]);
    expect((await run(f, b)).ignored).toBe(1);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.head).not.toHaveBeenCalled();
    expect(b.messages[0]?.ack).toHaveBeenCalledOnce();
  },
);
it.each([
  "KOKO_UPLOADS_ENABLED",
  "KOKO_UPLOAD_RECOVERY_ENABLED",
  "KOKO_UPLOAD_RECOVERY_QUEUE",
  "R2_ACCOUNT_ID",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
] as const)(
  "fails closed on missing %s; never implicitly acknowledges batch",
  async (field) => {
    const f = fixture(),
      b = batch();
    delete f.env[field];
    await expect(run(f, b)).rejects.toThrow(/^UPLOAD_RECOVERY_/);
    expect(b.messages[0]?.ack).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it("rejects wrong queue or oversized batches before upstream calls", async () => {
  const f = fixture();
  await expect(run(f, batch([body], "unrelated"))).rejects.toThrow(
    "QUEUE_NOT_READY",
  );
  await expect(run(f, batch(Array(11).fill(body)))).rejects.toThrow(
    "QUEUE_NOT_READY",
  );
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([
  "FORBIDDEN",
  "CONSENT_REQUIRED",
  "ACCOUNT_BANNED",
  "EVENT_CLOSED",
  "PUBLICATION_STOPPED",
  "THEME_UNAVAILABLE",
  "STATE_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
])("defers current guard %s without a retry storm or HEAD", async (code) => {
  const f = fixture([{ code }]),
    b = batch();
  expect((await run(f, b)).deferred).toBe(1);
  expect(f.head).not.toHaveBeenCalled();
  expect(b.messages[0]?.ack).toHaveBeenCalledOnce();
});
it("ignores unknown reservation", async () => {
  const f = fixture([{ code: "NOT_FOUND" }]);
  expect((await run(f)).ignored).toBe(1);
  expect(f.head).not.toHaveBeenCalled();
});
it.each([
  { code: "INTERNAL_ERROR" },
  { code: "INVALID_INPUT" },
  { code: "UPLOAD_INCOMPLETE" },
  { code: "unknown" },
  new Error("upstream-secret-must-not-escape"),
  new Response("secret", { status: 503 }),
  new Response(null, {
    status: 302,
    headers: { location: "https://evil.test" },
  }),
])(
  "retries transient/invalid RPC outcome %# with fixed classification",
  async (value) => {
    const f = fixture([value]),
      b = batch();
    expect((await run(f, b)).retry).toBe(1);
    expect(b.messages[0]?.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(b.messages[0]?.ack).not.toHaveBeenCalled();
    expect(f.head).not.toHaveBeenCalled();
  },
);
it.each([
  { asset_id: uploadId },
  { upload_id: "bad" },
  { object_key: "wrong" },
  { parts: null },
  { parts: [{ part_number: 1, etag: "a".repeat(32) }] },
  { file_size_bytes: -1 },
  { post_version: 0 },
  { provider_upload_id: "unexpected" },
  { mode: "multipart" },
])("rejects inconsistent prepared result %# before R2", async (extra) => {
  const f = fixture([{ ...prepared, ...extra }]);
  expect((await run(f)).retry).toBe(1);
  expect(f.head).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(1);
});
it("retry is per message, preserving other acknowledgements and continuing the batch", async () => {
  const f = fixture([receipt, new Error("secret"), receipt]),
    b = batch([body, body, body]);
  expect(await run(f, b)).toEqual({
    accepted: 2,
    retry: 1,
    ignored: 0,
    deferred: 0,
  });
  expect(b.messages[0]?.ack).toHaveBeenCalledOnce();
  expect(b.messages[1]?.retry).toHaveBeenCalledOnce();
  expect(b.messages[2]?.ack).toHaveBeenCalledOnce();
  expect(b.ackAll).not.toHaveBeenCalled();
  expect(b.retryAll).not.toHaveBeenCalled();
});
it.each([false, true])(
  "missing original causes retry only, multipart=%s never assembled in background",
  async (multi) => {
    const parts = Array.from({ length: 9 }, (_, i) => ({
      part_number: i + 1,
      etag: "a".repeat(32),
    }));
    const f = fixture([
      {
        ...prepared,
        ...(multi
          ? {
              mode: "multipart",
              file_size_bytes: 65 * 1024 ** 2,
              parts,
              provider_upload_id: "known-provider",
            }
          : {}),
      },
    ]);
    f.head.mockResolvedValue(null);
    expect((await run(f)).retry).toBe(1);
    expect(f.head).toHaveBeenCalledOnce();
    expect(f.resumeMultipartUpload).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(1);
  },
);
it("saved multipart uses frozen manifest and matching composed ETag", async () => {
  const parts = Array.from({ length: 9 }, (_, i) => ({
    part_number: i + 1,
    etag: "a".repeat(32),
  }));
  const f = fixture([
    {
      ...prepared,
      mode: "multipart",
      file_size_bytes: 65 * 1024 ** 2,
      parts,
      provider_upload_id: "known-provider",
    },
    receipt,
  ]);
  f.head.mockResolvedValue({
    key,
    size: 65 * 1024 ** 2,
    etag: await multipartEtag(parts),
    version: "saved-version",
  } as R2Object);
  expect(
    (await run(f, batch([{ ...body, action: "CompleteMultipartUpload" }])))
      .accepted,
  ).toBe(1);
  expect(f.resumeMultipartUpload).not.toHaveBeenCalled();
});
it.each([{ size: 999 }, { etag: "wrong" }, { version: "" }, { key: "wrong" }])(
  "HEAD mismatch %# never commits",
  async (extra) => {
    const f = fixture();
    f.head.mockResolvedValue({
      key,
      size: 123,
      etag: "a".repeat(32),
      version: "v1",
      ...extra,
    } as R2Object);
    expect((await run(f)).retry).toBe(1);
    expect(f.calls).toHaveLength(1);
  },
);
it("commit ambiguity retries, next delivery receives receipt without second HEAD", async () => {
  const f = fixture([prepared, new Error("lost response"), receipt]);
  expect((await run(f)).retry).toBe(1);
  expect((await run(f)).accepted).toBe(1);
  expect(f.head).toHaveBeenCalledOnce();
});
it("guard change between prepare/commit stays deferred, not accepted", async () => {
  const f = fixture([prepared, { code: "ACCOUNT_BANNED" }]);
  expect((await run(f)).deferred).toBe(1);
});
it("invalid final receipt never counts as accepted", async () => {
  const f = fixture([
    prepared,
    { ...receipt, post: { ...receipt.post, event_id: uploadId } },
  ]);
  expect((await run(f)).retry).toBe(1);
});
it("scheduled disabled no-ops; wrong cron fails closed", async () => {
  const f = fixture();
  delete f.env.KOKO_UPLOAD_RECOVERY_ENABLED;
  expect(await scan(f)).toBeNull();
  expect(f.fetcher).not.toHaveBeenCalled();
  f.env.KOKO_UPLOAD_RECOVERY_ENABLED = "true";
  await expect(
    handleUploadRecoveryScheduled({ cron: "* * * * *" }, f.env, f.fetcher),
  ).rejects.toThrow("CRON_NOT_READY");
});
it("scheduled claim uses fixed bounded RPC, then same completion path", async () => {
  const f = fixture([candidates, prepared, receipt]);
  expect((await scan(f))?.accepted).toBe(1);
  expect(f.calls[0]).toEqual({
    name: "/rest/v1/rpc/claim_upload_recovery",
    input: { p_limit: 10 },
  });
  expect(f.resumeMultipartUpload).not.toHaveBeenCalled();
});
it.each([
  {},
  { ...candidates, items: [item, item] },
  { ...candidates, items: [item, {}] },
  { ...candidates, items: Array(11).fill(item) },
  { ...candidates, items: [{ ...item, user_id: "injected" }] },
])(
  "invalid candidate list %# is rejected before any HEAD/recovery RPC",
  async (value) => {
    const f = fixture([value]);
    await expect(scan(f)).rejects.toThrow("CANDIDATES_INVALID");
    expect(f.head).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(1);
  },
);
it("scheduled one failure does not prevent next candidate", async () => {
  const second = { ...item, asset_id: uploadId };
  const f = fixture([
    { ...candidates, items: [item, second] },
    new Error("failure"),
    receipt,
  ]);
  expect(await scan(f)).toEqual({
    accepted: 1,
    retry: 1,
    deferred: 0,
    ignored: 0,
  });
});
it("Worker entrypoints are default-off and no HTTP recovery route is exposed", async () => {
  const f = fixture();
  delete f.env.KOKO_UPLOAD_RECOVERY_ENABLED;
  await expect(worker.queue(batch(), f.env as unknown as Env)).rejects.toThrow(
    "QUEUE_NOT_READY",
  );
  await worker.scheduled(
    { cron: recoveryCron } as ScheduledController,
    f.env as unknown as Env,
  );
  const result = await worker.fetch(
    new Request("https://api.example.test/internal/recover-upload") as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    f.env as unknown as Env,
  );
  expect(result.status).toBe(404);
  expect(f.fetcher).not.toHaveBeenCalled();
});
