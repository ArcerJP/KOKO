import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function dispatch(
  path: string,
  init?: RequestInit<IncomingRequestCfProperties>,
): Promise<Response> {
  const request = new IncomingRequest(`https://api.example.test${path}`, init);
  return worker.fetch(request, env);
}

describe("KOKO API Worker", () => {
  it("GET /healthはキャッシュしない正常応答を返す", async () => {
    const response = await dispatch("/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    await expect(response.json()).resolves.toEqual({
      service: "koko-api",
      status: "ok",
    });
  });

  it("healthへのGET以外を拒否する", async () => {
    const response = await dispatch("/health", { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    await expect(response.json()).resolves.toEqual({
      error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
    });
  });

  it("未定義routeを404にする", async () => {
    const response = await dispatch("/media/private-object");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "Not found" },
    });
  });

  it.each(["/uploads", "/uploads/example/refresh", "/uploads/example/parts"])(
    "%sは受付flagが未設定なら公開しない",
    async (path) => {
      const response = await dispatch(path, { method: "POST" });
      expect(response.status).toBe(404);
    },
  );

  it("/consentsを認証必須POSTへルーティングする", async () => {
    const get = await dispatch("/consents");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const post = await dispatch("/consents", {
      method: "POST",
      headers: { "X-Event-ID": "11111111-1111-4111-8111-111111111111" },
    });
    expect(post.status).toBe(401);
    expect(await post.json()).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("原本と派生物のR2 bindingをローカルで分離する", async () => {
    const key = "tests/binding-isolation.txt";
    await env.ORIGINALS_BUCKET.put(key, "original");

    await expect(env.ORIGINALS_BUCKET.get(key)).resolves.not.toBeNull();
    await expect(env.DERIVED_BUCKET.get(key)).resolves.toBeNull();
  });

  it.each([
    "/feed",
    "/themes",
    "/admin/feed",
    "/admin/settings",
    "/internal/stream-webhook",
    "/posts/11111111-1111-4111-8111-111111111111",
    "/admin/posts/11111111-1111-4111-8111-111111111111/original?expected_version=1",
    "/media/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/webp-600",
  ])("第3の %s は既定で無効", async (path) => {
    expect((await dispatch(path)).status).toBe(404);
  });

  it("未設定の定期処理は外部通信も成功ログも発生させない", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const logger = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      for (const cron of ["* * * * *", "*/5 * * * *"])
        await worker.scheduled({ cron, scheduledTime: 0, noRetry() {} }, env);
      expect(fetcher).not.toHaveBeenCalled();
      expect(logger).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
      logger.mockRestore();
    }
  });

  it("未設定のQueueを暗黙ACKせず拒否する", async () => {
    await expect(
      worker.queue(
        {
          queue: "unknown",
          messages: [],
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          ackAll() {},
          retryAll() {},
        },
        env,
      ),
    ).rejects.toThrow("UPLOAD_RECOVERY_QUEUE_NOT_READY");
  });
});
