import { afterEach, describe, expect, it, vi } from "vitest";
import { completeSignOut } from "../src/auth/sign-out";

afterEach(() => vi.useRealTimers());
describe("ブラウザlogoutの順序と部分失敗", () => {
  it("既定無効では従来Authだけ", async () => {
    const auth = vi.fn().mockResolvedValue({ error: null });
    const fetcher = vi.fn<typeof fetch>();
    await completeSignOut(false, auth, fetcher);
    expect(auth).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("API経路を閉じてからAuthを終了、値や外部URLを渡さない", async () => {
    const order: string[] = [];
    const auth = vi.fn(async () => {
      order.push("auth");
      return { error: null };
    });
    const fetcher = vi.fn<typeof fetch>(async () => {
      order.push("api");
      return Response.json({ ok: true });
    });
    await completeSignOut(true, auth, fetcher);
    expect(order).toEqual(["api", "auth"]);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/auth/api-sign-out", {
      method: "POST",
      headers: { "X-KOKO-Session-Request": "1", Accept: "application/json" },
      mode: "same-origin",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });
  it.each([
    () => {
      throw new Error("private-canary");
    },
    () => Response.json({ ok: true }, { status: 503 }),
    () => Response.json({ ok: false }),
    () => Response.json({ ok: true, token: "private-canary" }),
    () => Response.json(null),
    () => Response.json([]),
    () =>
      new Response("<html>Access</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    () => Response.redirect("https://other.example.test", 302),
    () =>
      new Response("not json", {
        headers: { "Content-Type": "application/json" },
      }),
    () => Response.json({ ok: true, padding: "a".repeat(200) }),
  ])("API失敗でもAuthを試し、完了は偽らない %#", async (reply) => {
    const auth = vi.fn().mockResolvedValue({ error: null });
    const fetcher = vi.fn<typeof fetch>(async () => reply());
    await expect(completeSignOut(true, auth, fetcher)).rejects.toThrow(
      "SIGN_OUT_INCOMPLETE",
    );
    expect(auth).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "Auth失敗を固定メッセージにする enabled=%s",
    async (enabled) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        Response.json({ ok: true }),
      );
      await expect(
        completeSignOut(
          enabled,
          async () => ({ error: new Error("private-canary") }),
          fetcher,
        ),
      ).rejects.toThrow("SIGN_OUT_INCOMPLETE");
    },
  );
  it("Auth生成/SDK例外も固定化", async () => {
    await expect(
      completeSignOut(false, async () => {
        throw new Error("private-canary");
      }),
    ).rejects.toThrow("SIGN_OUT_INCOMPLETE");
  });
  it.each(["headers", "body"])(
    "APIの%s停止でも10秒後Auth終了を試す",
    async (phase) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      const fetcher = vi.fn<typeof fetch>(async () =>
        phase === "headers"
          ? new Promise<Response>(() => {})
          : new Response(new ReadableStream({ cancel }), {
              headers: { "Content-Type": "application/json" },
            }),
      );
      const auth = vi.fn().mockResolvedValue({ error: null });
      const pending = expect(
        completeSignOut(true, auth, fetcher),
      ).rejects.toThrow("SIGN_OUT_INCOMPLETE");
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      expect(auth).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      if (phase === "body") expect(cancel).toHaveBeenCalledOnce();
    },
  );
});
