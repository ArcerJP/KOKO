import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function dispatch(
  path: string,
  init?: RequestInit<IncomingRequestCfProperties>,
): Promise<Response> {
  const request = new IncomingRequest(`https://api.example.test${path}`, init);
  return worker.fetch(request);
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

  it("原本と派生物のR2 bindingをローカルで分離する", async () => {
    const key = "tests/binding-isolation.txt";
    await env.ORIGINALS_BUCKET.put(key, "original");

    await expect(env.ORIGINALS_BUCKET.get(key)).resolves.not.toBeNull();
    await expect(env.DERIVED_BUCKET.get(key)).resolves.toBeNull();
  });
});
