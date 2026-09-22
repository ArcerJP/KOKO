import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { ApiFailure, createApiClient } from "../src/api/client";
import { mockEventId, mockHandlers, mockMe } from "../src/mocks/handlers";

const base = new URL("http://127.0.0.1:3100/api/");
const endpoint = new URL("me", base).href;
const server = setupServer(...mockHandlers());
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("生成契約型を利用するGET境界とMSW", () => {
  it("表示名の上限をUnicode文字数で検査する", async () => {
    const displayName = "🐱".repeat(50);
    server.use(
      http.get(endpoint, () =>
        HttpResponse.json({ ...mockMe, display_name: displayName }),
      ),
    );
    expect(
      (await createApiClient(base, mockEventId).getMe()).display_name,
    ).toBe(displayName);
  });
  it("レスポンス本文を待つ間の取消しも維持する", async () => {
    const controller = new AbortController();
    const fetcher: typeof fetch = async () => {
      const response = new Response(JSON.stringify(mockMe));
      response.json = async () => {
        controller.abort();
        throw new DOMException("中止", "AbortError");
      };
      return response;
    };
    await expect(
      createApiClient(base, mockEventId, fetcher).getMe(controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("event headerを送り、契約どおりの/meを受け取る", async () => {
    const fetcher = vi.fn(fetch);
    expect(await createApiClient(base, mockEventId, fetcher).getMe()).toEqual(
      mockMe,
    );
    expect(fetcher).toHaveBeenCalledWith(
      new URL(endpoint),
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json", "X-Event-ID": mockEventId },
      }),
    );
  });
  it("別eventはサーバー側で拒否する", async () => {
    await expect(
      createApiClient(base, "00000000-0000-4000-8000-000000000009").getMe(),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("認証エラーを安全な契約メッセージへ変換する", async () => {
    server.use(
      http.get(endpoint, () =>
        HttpResponse.json(
          {
            code: "AUTH_REQUIRED",
            request_id: "00000000-0000-4000-8000-000000000003",
            internal: "secret-test-only",
          },
          { status: 401 },
        ),
      ),
    );
    const error = await createApiClient(base, mockEventId)
      .getMe()
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiFailure);
    expect(error).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(String(error)).not.toContain("secret-test-only");
  });
  it.each([
    { ...mockMe, event_id: "wrong" },
    { ...mockMe, role: "owner" },
    { ...mockMe, is_banned: "false" },
    { ...mockMe, csrf_token: "short" },
    { ...mockMe, display_name: "" },
    { ...mockMe, crown: "rainbow" },
    null,
  ])("不正な成功レスポンスを受理しない (%j)", async (body) => {
    server.use(http.get(endpoint, () => HttpResponse.json(body)));
    await expect(
      createApiClient(base, mockEventId).getMe(),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
  it("非JSON・不正なエラーstatusをそのまま表示しない", async () => {
    server.use(
      http.get(
        endpoint,
        () => new HttpResponse("internal detail", { status: 500 }),
      ),
    );
    await expect(
      createApiClient(base, mockEventId).getMe(),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    server.use(
      http.get(endpoint, () =>
        HttpResponse.json(
          {
            code: "AUTH_REQUIRED",
            request_id: "00000000-0000-4000-8000-000000000003",
          },
          { status: 500 },
        ),
      ),
    );
    await expect(
      createApiClient(base, mockEventId).getMe(),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
  it("通信失敗と利用者の取消しを区別する", async () => {
    server.use(http.get(endpoint, () => HttpResponse.error()));
    await expect(
      createApiClient(base, mockEventId).getMe(),
    ).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    await expect(
      createApiClient(base, mockEventId).getMe(AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it.each([
    "http://example.com/api/",
    "https://name:password@example.com/api/",
    "https://example.com/api/?key=x",
    "https://example.com/api/#secret",
    "https://example.com/api",
  ])("危険なAPI設定を拒否する: %s", (url) => {
    expect(() => createApiClient(new URL(url), mockEventId)).toThrow(TypeError);
  });
});
