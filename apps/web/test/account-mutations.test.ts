import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  ApiFailure,
  createApiClient,
  type AcceptTerms,
  type Me,
  type UpdateMe,
} from "../src/api/client";
import { mockEventId, mockMe } from "../src/mocks/handlers";

const base = new URL("http://127.0.0.1:3100/api/");
const meUrl = new URL("me", base).href;
const consentUrl = new URL("consents", base).href;
// Node/MSW専用の合成値。認証や本物のCSRF検証を模擬できたとは扱わない。
const csrf = "mock-session-csrf-token-for-node-tests-only";
const requestId = "00000000-0000-4000-8000-000000000003";
const ack = { request_id: requestId };
const server = setupServer();
let current: Me;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  current = { ...mockMe, csrf_token: csrf };
  server.use(
    http.get(meUrl, () => HttpResponse.json(current)),
    http.patch(meUrl, async ({ request }) => {
      if (
        request.headers.get("X-Event-ID") !== mockEventId ||
        request.headers.get("X-CSRF-Token") !== csrf
      )
        return HttpResponse.json(
          { code: "FORBIDDEN", request_id: requestId },
          { status: 403 },
        );
      const body = (await request.json()) as UpdateMe;
      current.display_name = body.display_name;
      return HttpResponse.json(ack);
    }),
    http.post(consentUrl, async ({ request }) => {
      if (
        request.headers.get("X-Event-ID") !== mockEventId ||
        request.headers.get("X-CSRF-Token") !== csrf
      )
        return HttpResponse.json(
          { code: "FORBIDDEN", request_id: requestId },
          { status: 403 },
        );
      const body = (await request.json()) as AcceptTerms;
      if (
        body.accepted !== true ||
        body.terms_version !== current.terms_version
      )
        return HttpResponse.json(
          { code: "CONSENT_REQUIRED", request_id: requestId },
          { status: 403 },
        );
      current.consent_required = false;
      return HttpResponse.json(ack);
    }),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
});
afterAll(() => server.close());

const mutations = [
  {
    method: "PATCH",
    path: "me",
    input: { display_name: "新しい表示名" },
    handler: http.patch,
    run: (
      client: ReturnType<typeof createApiClient>,
      token: string,
      signal?: AbortSignal,
    ) => client.updateMe({ display_name: "新しい表示名" }, token, signal),
  },
  {
    method: "POST",
    path: "consents",
    input: { terms_version: "test-only", accepted: true },
    handler: http.post,
    run: (
      client: ReturnType<typeof createApiClient>,
      token: string,
      signal?: AbortSignal,
    ) =>
      client.acceptTerms(
        { terms_version: "test-only", accepted: true },
        token,
        signal,
      ),
  },
] as const;

describe("表示名・同意の合成HTTP往復", () => {
  it("取得→表示名変更→再取得→明示同意→再取得", async () => {
    const client = createApiClient(base, mockEventId);
    const before = await client.getMe();
    expect(before.consent_required).toBe(true);
    expect(
      await client.updateMe({ display_name: "変更後" }, before.csrf_token!),
    ).toEqual(ack);
    const renamed = await client.getMe();
    expect(renamed.display_name).toBe("変更後");
    expect(renamed.consent_required).toBe(true);
    expect(
      await client.acceptTerms(
        { terms_version: renamed.terms_version, accepted: true },
        renamed.csrf_token!,
      ),
    ).toEqual(ack);
    expect((await client.getMe()).consent_required).toBe(false);
    // ローカルの古い応答を書き換えて成功を推測しない。
    expect(before.display_name).toBe(mockMe.display_name);
    expect(renamed.consent_required).toBe(true);
  });

  it("画面表示後の規約改訂は拒否され、自動で最新版へ同意し直さない", async () => {
    const fetcher = vi.fn(fetch);
    const client = createApiClient(base, mockEventId, fetcher);
    const before = await client.getMe();
    current.terms_version = "test-only-revised";
    fetcher.mockClear();
    await expect(
      client.acceptTerms(
        { terms_version: before.terms_version, accepted: true },
        csrf,
      ),
    ).rejects.toMatchObject({ code: "CONSENT_REQUIRED", requestId });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(current.consent_required).toBe(true);
    expect((await client.getMe()).terms_version).toBe("test-only-revised");
  });

  it("同意の重複送信とBAN状態を同一視しない", async () => {
    current.is_banned = true;
    const client = createApiClient(base, mockEventId);
    const input = {
      terms_version: current.terms_version,
      accepted: true,
    } as const;
    await client.acceptTerms(input, csrf);
    await client.acceptTerms(input, csrf);
    expect(await client.getMe()).toMatchObject({
      is_banned: true,
      consent_required: false,
    });
  });

  it.each(["名", "🐱".repeat(50), "  表示名  "])(
    "許可された表示名を勝手に整形しない (%s)",
    async (display_name) => {
      const client = createApiClient(base, mockEventId);
      await client.updateMe({ display_name }, csrf);
      expect((await client.getMe()).display_name).toBe(display_name);
    },
  );

  it.each([
    null,
    [],
    {},
    { display_name: "" },
    { display_name: " \t" },
    { display_name: 1 },
    { display_name: "🐱".repeat(51) },
    { display_name: "a\nb" },
    { display_name: "a\u200bb" },
    { display_name: "a", role: "admin" },
  ])("不正な表示名入力は送信前に拒否する (%j)", async (input) => {
    const fetcher = vi.fn(fetch);
    await expect(
      createApiClient(base, mockEventId, fetcher).updateMe(
        input as UpdateMe,
        csrf,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { terms_version: "test-only" },
    { terms_version: "test-only", accepted: false },
    { terms_version: "test-only", accepted: "true" },
    { terms_version: "", accepted: true },
    { terms_version: " \t", accepted: true },
    { terms_version: 1, accepted: true },
    { terms_version: "test-only", accepted: true, user_id: mockMe.user_id },
    { terms_version: "test-only", accepted: true, accepted_at: "2026-10-04" },
  ])("不正な同意入力は送信前に拒否する (%j)", async (input) => {
    const fetcher = vi.fn(fetch);
    await expect(
      createApiClient(base, mockEventId, fetcher).acceptTerms(
        input as AcceptTerms,
        csrf,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("UTF-8で1KiBを超える入力は送信しない", async () => {
    const fetcher = vi.fn(fetch);
    await expect(
      createApiClient(base, mockEventId, fetcher).acceptTerms(
        { terms_version: "規".repeat(400), accepted: true },
        csrf,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe.each(mutations)(
  "$method $path の安全境界",
  ({ method, path, input, handler, run }) => {
    const url = new URL(path, base);
    it("固定経路・JSON・イベント・CSRF・同一origin・非キャッシュで1回送信", async () => {
      const fetcher = vi.fn(fetch);
      const signal = new AbortController().signal;
      expect(
        await run(createApiClient(base, mockEventId, fetcher), csrf, signal),
      ).toEqual(ack);
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(url, {
        method,
        headers: {
          Accept: "application/json",
          "X-Event-ID": mockEventId,
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
        },
        mode: "same-origin",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        body: JSON.stringify(input),
        signal,
      });
      expect(url.href).not.toContain(csrf);
      expect(fetcher.mock.calls[0]?.[1]?.body).not.toContain(csrf);
    });

    it.each([
      undefined,
      null,
      "",
      "a".repeat(31),
      "a".repeat(257),
      "a".repeat(32) + "\r\n",
      " " + "a".repeat(32),
      "あ".repeat(32),
    ])("不正・欠落tokenを補完せず拒否 (%j)", async (token) => {
      const fetcher = vi.fn(fetch);
      await expect(
        run(createApiClient(base, mockEventId, fetcher), token as string),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([32, 256])("token長の境界 %i を送信できる", async (size) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(ack));
      await run(createApiClient(base, mockEventId, fetcher), "a".repeat(size));
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("形式が正しくても別セッションtokenはサーバー拒否のまま", async () => {
      await expect(
        run(
          createApiClient(base, mockEventId),
          "different-session-token-for-node-tests-only",
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it.each([
      [401, "AUTH_REQUIRED"],
      [403, "FORBIDDEN"],
      [403, "CONSENT_REQUIRED"],
      [403, "ACCOUNT_BANNED"],
      [400, "INVALID_INPUT"],
      [429, "RATE_LIMITED"],
      [500, "INTERNAL_ERROR"],
    ])("HTTP %i / %s を固定メッセージにし再送しない", async (status, code) => {
      server.use(
        handler(url.href, () =>
          HttpResponse.json(
            {
              code,
              request_id: requestId,
              internal: "do-not-show-internal-detail",
            },
            { status: status as number },
          ),
        ),
      );
      const fetcher = vi.fn(fetch);
      const error = await run(
        createApiClient(base, mockEventId, fetcher),
        csrf,
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ApiFailure);
      expect(error).toMatchObject({ code, requestId });
      expect(String(error)).not.toContain("do-not-show-internal-detail");
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it.each([
      null,
      {},
      [],
      { request_id: "not-uuid" },
      { request_id: 3 },
      { ...ack, resource_id: "bad" },
      { ...ack, resource_id: null },
    ])("不正な成功応答を受理しない (%j)", async (body) => {
      server.use(handler(url.href, () => HttpResponse.json(body)));
      await expect(
        run(createApiClient(base, mockEventId), csrf),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    });

    it("ackにない余分な項目を呼出し元へ渡さない", async () => {
      server.use(
        handler(url.href, () =>
          HttpResponse.json({
            ...ack,
            resource_id: mockEventId,
            internal: "hidden",
            csrf_token: csrf,
          }),
        ),
      );
      expect(await run(createApiClient(base, mockEventId), csrf)).toEqual({
        ...ack,
        resource_id: mockEventId,
      });
    });

    it.each([201, 202, 403, 500])(
      "正しいackでも契約外HTTP %i を成功扱いしない",
      async (status) => {
        server.use(handler(url.href, () => HttpResponse.json(ack, { status })));
        await expect(
          run(createApiClient(base, mockEventId), csrf),
        ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      },
    );

    it("エラーcodeとHTTP statusの矛盾を隠蔽せず内部エラーへ限定", async () => {
      server.use(
        handler(url.href, () =>
          HttpResponse.json(
            { code: "AUTH_REQUIRED", request_id: requestId },
            { status: 500 },
          ),
        ),
      );
      await expect(
        run(createApiClient(base, mockEventId), csrf),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    });

    it("非JSON応答を画面表示用エラーへ流さない", async () => {
      server.use(
        handler(
          url.href,
          () => new HttpResponse("internal detail", { status: 500 }),
        ),
      );
      await expect(
        run(createApiClient(base, mockEventId), csrf),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    });

    it("redirectに追従せず、失敗を再送しない", async () => {
      server.use(
        handler(
          url.href,
          () =>
            new HttpResponse(null, {
              status: 307,
              headers: { Location: "https://must-not-send.invalid/" },
            }),
        ),
      );
      const fetcher = vi.fn(fetch);
      await expect(
        run(createApiClient(base, mockEventId, fetcher), csrf),
      ).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("通信例外の詳細を隠し再送しない", async () => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("internal detail " + csrf));
      const error = await run(
        createApiClient(base, mockEventId, fetcher),
        csrf,
      ).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "NETWORK_UNAVAILABLE" });
      expect(String(error)).not.toContain(csrf);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("送信前の取消しはHTTP通信しない", async () => {
      const fetcher = vi.fn(fetch);
      await expect(
        run(
          createApiClient(base, mockEventId, fetcher),
          csrf,
          AbortSignal.abort(),
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("応答body待機中の取消しも維持する", async () => {
      const controller = new AbortController();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        const response = Response.json(ack);
        response.json = async () => {
          controller.abort();
          throw new Error("internal detail");
        };
        return response;
      });
      await expect(
        run(
          createApiClient(base, mockEventId, fetcher),
          csrf,
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  },
);

describe("送信先と不確定な保存結果", () => {
  it("Bearer用GETにtokenがなければ偽tokenを作らず更新を止める", async () => {
    server.use(http.get(meUrl, () => HttpResponse.json(mockMe)));
    const fetcher = vi.fn(fetch);
    const client = createApiClient(base, mockEventId, fetcher);
    const me = await client.getMe();
    expect(me.csrf_token).toBeUndefined();
    fetcher.mockClear();
    await expect(
      client.updateMe({ display_name: "名" }, me.csrf_token!),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([1024, 1025])(
    "JSON全体の入力上限 %i bytesを検査する",
    async (size) => {
      const overhead = JSON.stringify({
        terms_version: "",
        accepted: true,
      }).length;
      const input = {
        terms_version: "a".repeat(size - overhead),
        accepted: true,
      } as const;
      expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBe(
        size,
      );
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(ack));
      const result = createApiClient(base, mockEventId, fetcher).acceptTerms(
        input,
        csrf,
      );
      if (size === 1024) {
        await expect(result).resolves.toEqual(ack);
        expect(fetcher).toHaveBeenCalledTimes(1);
      } else {
        await expect(result).rejects.toMatchObject({ code: "INVALID_INPUT" });
        expect(fetcher).not.toHaveBeenCalled();
      }
    },
  );

  it("更新後のGETに直前のCSRF tokenを付けない", async () => {
    const fetcher = vi.fn(fetch);
    const client = createApiClient(base, mockEventId, fetcher);
    await client.updateMe({ display_name: "名" }, csrf);
    await client.getMe();
    expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({
      Accept: "application/json",
      "X-Event-ID": mockEventId,
    });
  });

  it("別originをブラウザ文脈では通信前に拒否する", () => {
    vi.stubGlobal("location", { origin: "https://koko.example" });
    const fetcher = vi.fn(fetch);
    expect(() => createApiClient(base, mockEventId, fetcher)).toThrow(
      "同一origin",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("作成後もlocationを検査しGET/更新とも別originへ送らない", async () => {
    vi.stubGlobal("location", { origin: base.origin });
    const fetcher = vi.fn(fetch);
    const client = createApiClient(base, mockEventId, fetcher);
    vi.stubGlobal("location", { origin: "https://other.example" });
    await expect(client.getMe()).rejects.toThrow("同一origin");
    await expect(client.updateMe({ display_name: "名" }, csrf)).rejects.toThrow(
      "同一origin",
    );
    await expect(
      client.acceptTerms({ terms_version: "test-only", accepted: true }, csrf),
    ).rejects.toThrow("同一origin");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("元URLの変更で送信先やpathを変更させない", async () => {
    const mutableBase = new URL(base);
    const fetcher = vi.fn(fetch);
    const client = createApiClient(mutableBase, mockEventId, fetcher);
    mutableBase.hostname = "other.example";
    mutableBase.pathname = "/wrong/";
    await client.updateMe({ display_name: "名" }, csrf);
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL(meUrl));
  });

  it("保存後に応答を失った場合も再送せず、再GETで状態を確認できる", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, options) => {
        const response = await fetch(url, options);
        if (options?.method === "PATCH") throw new Error("response lost");
        return response;
      });
    const client = createApiClient(base, mockEventId, fetcher);
    await expect(
      client.updateMe({ display_name: "保存は完了" }, csrf),
    ).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await client.getMe()).display_name).toBe("保存は完了");
  });
});
