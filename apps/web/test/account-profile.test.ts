import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountProfile } from "../src/api/account-profile";
import { createApiClient } from "../src/api/client";
import { accountEventId } from "../src/api/account-config";
import { postApiSession } from "../src/auth/session-post";
import { mockMe, mockEventId } from "../src/mocks/handlers";

const csrf = "synthetic-csrf-value-for-profile-tests";
const me = { ...mockMe, csrf_token: csrf, is_banned: false };
const changed = "新しい表示名";
function setup() {
  const client = {
    getMe: vi.fn().mockResolvedValue(me),
    updateMe: vi.fn().mockResolvedValue({
      request_id: "00000000-0000-4000-8000-000000000001",
    }),
  };
  const prepare = vi.fn().mockResolvedValue(true);
  const profile = createAccountProfile(client, prepare);
  return { client, prepare, profile };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe("本人情報controller", () => {
  it("初期化では通信せず、snapshotは安定・秘密を含まない", async () => {
    const { profile, client, prepare } = setup();
    expect(profile.getSnapshot()).toBe(profile.getSnapshot());
    expect(profile.getSnapshot()).toBe(profile.getServerSnapshot());
    expect(prepare).not.toHaveBeenCalled();
    const subscriber = vi.fn();
    const unsubscribe = profile.subscribe(subscriber);
    await profile.load();
    expect(profile.getSnapshot()).toMatchObject({
      phase: "ready",
      displayName: me.display_name,
      draft: me.display_name,
    });
    expect(Object.isFrozen(profile.getSnapshot())).toBe(true);
    expect(JSON.stringify(profile.getSnapshot())).not.toContain(csrf);
    expect(JSON.stringify(profile.getSnapshot())).not.toContain(me.user_id);
    expect(subscriber).toHaveBeenCalledTimes(2);
    unsubscribe();
    profile.edit(changed);
    expect(subscriber).toHaveBeenCalledTimes(2);
    expect(client.getMe).toHaveBeenCalledOnce();
  });
  it("prepare→GET→edit→prepare→fresh GET→PATCH→確認GETの順序", async () => {
    const order: string[] = [];
    let name = me.display_name;
    let version = 0;
    const client = createApiClient(
      new URL("https://web.example.test/api/"),
      mockEventId,
      async (url, init) => {
        expect(new URL(String(url)).pathname).toBe("/api/me");
        expect(init?.credentials).toBe("same-origin");
        expect(init?.redirect).toBe("error");
        if (init?.method === "PATCH") {
          order.push("PATCH");
          expect(new Headers(init.headers).get("X-CSRF-Token")).toBe(
            `${csrf}-${version}`,
          );
          name = JSON.parse(String(init.body)).display_name;
          return Response.json({
            request_id: "00000000-0000-4000-8000-000000000001",
          });
        }
        order.push("GET");
        return Response.json({
          ...me,
          display_name: name,
          csrf_token: `${csrf}-${++version}`,
        });
      },
    );
    const profile = createAccountProfile(client, async () => {
      order.push("prepare");
      return true;
    });
    await profile.load();
    profile.edit(changed);
    await profile.save();
    expect(order).toEqual(["prepare", "GET", "prepare", "GET", "PATCH", "GET"]);
    expect(profile.getSnapshot()).toMatchObject({
      phase: "ready",
      displayName: changed,
      error: false,
    });
    expect(profile.getSnapshot().message).toContain("保存し");
  });
  it.each(["prepare", "get", "missing-csrf"])(
    "読込み失敗で古い値を残さない %s",
    async (mode) => {
      const { profile, client, prepare } = setup();
      await profile.load();
      if (mode === "prepare") prepare.mockResolvedValue(false);
      if (mode === "get")
        client.getMe.mockRejectedValue(new Error("private-canary"));
      if (mode === "missing-csrf") client.getMe.mockResolvedValue(mockMe);
      await profile.load();
      expect(profile.getSnapshot()).toMatchObject({
        phase: "error",
        displayName: null,
        draft: "",
      });
      expect(JSON.stringify(profile.getSnapshot())).not.toContain(
        "private-canary",
      );
    },
  );
  it.each(["", " ", "a".repeat(51), "ab\u200bcd", "a\nb"])(
    "不正な表示名は通信しない %#",
    async (name) => {
      const { profile, client, prepare } = setup();
      await profile.load();
      profile.edit(name);
      await profile.save();
      expect(client.updateMe).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledOnce();
      expect(profile.getSnapshot().error).toBe(true);
    },
  );
  it("未読込み・未変更・BANは保存しない", async () => {
    const { profile, client, prepare } = setup();
    await profile.save();
    expect(prepare).not.toHaveBeenCalled();
    await profile.load();
    await profile.save();
    client.getMe.mockResolvedValue({ ...me, is_banned: true });
    await profile.load();
    profile.edit(changed);
    await profile.save();
    expect(profile.getSnapshot().blocked).toBe(true);
    expect(client.updateMe).not.toHaveBeenCalled();
  });
  it.each([
    { user_id: "44444444-4444-4444-8444-444444444444" },
    { event_id: "55555555-5555-4555-8555-555555555555" },
    { display_name: "別タブの変更" },
    { is_banned: true },
    { csrf_token: undefined },
  ])("fresh本人/状態が変わったらPATCHしない %#", async (patch) => {
    const { profile, client } = setup();
    await profile.load();
    profile.edit(changed);
    client.getMe.mockResolvedValue({ ...me, ...patch });
    await profile.save();
    expect(client.updateMe).not.toHaveBeenCalled();
    expect(profile.getSnapshot()).toMatchObject({
      phase: "error",
      displayName: null,
    });
  });
  it.each([
    "ack-lost",
    "confirm-failed",
    "confirm-wrong-name",
    "confirm-other-user",
    "confirm-banned",
  ])("保存を再送せず不確かな結果を成功扱いしない %s", async (mode) => {
    const { profile, client } = setup();
    await profile.load();
    profile.edit(changed);
    if (mode === "ack-lost")
      client.updateMe.mockRejectedValue(new Error("private-save-canary"));
    else {
      client.getMe.mockResolvedValueOnce(me);
      if (mode === "confirm-failed")
        client.getMe.mockRejectedValueOnce(new Error("private-save-canary"));
      else
        client.getMe.mockResolvedValueOnce({
          ...me,
          display_name: mode === "confirm-wrong-name" ? "別名" : changed,
          ...(mode === "confirm-other-user" ? { user_id: "other" } : {}),
          is_banned: mode === "confirm-banned",
        });
    }
    await profile.save();
    expect(client.updateMe).toHaveBeenCalledOnce();
    expect(profile.getSnapshot()).toMatchObject({
      phase: "error",
      displayName: null,
    });
    expect(profile.getSnapshot().message).toContain("再送せず");
    await profile.save();
    expect(client.updateMe).toHaveBeenCalledOnce();
    expect(JSON.stringify(profile.getSnapshot())).not.toContain(
      "private-save-canary",
    );
  });
  it("同一操作の二重押下は1回だけ", async () => {
    const { profile, client, prepare } = setup();
    const waiting = deferred<typeof me>();
    client.getMe.mockReturnValueOnce(waiting.promise);
    const first = profile.load();
    await profile.load();
    await profile.save();
    expect(prepare).toHaveBeenCalledOnce();
    waiting.resolve(me);
    await first;
    profile.edit(changed);
    const ack = deferred<{ request_id: string }>();
    client.updateMe.mockReturnValueOnce(ack.promise);
    client.getMe
      .mockResolvedValueOnce(me)
      .mockResolvedValueOnce({ ...me, display_name: changed });
    const saving = profile.save();
    await profile.save();
    ack.resolve({ request_id: "00000000-0000-4000-8000-000000000001" });
    await saving;
    expect(client.updateMe).toHaveBeenCalledOnce();
  });
  it.each(["prepare", "get", "patch", "confirm"])(
    "終了後の遅延%sで画面や要求が復活しない",
    async (phase) => {
      const { profile, client, prepare } = setup();
      const wait = deferred<unknown>();
      if (phase === "prepare") prepare.mockReturnValueOnce(wait.promise);
      if (phase === "get") client.getMe.mockReturnValueOnce(wait.promise);
      if (phase === "patch" || phase === "confirm") {
        await profile.load();
        profile.edit(changed);
      }
      if (phase === "patch") client.updateMe.mockReturnValueOnce(wait.promise);
      if (phase === "confirm")
        client.getMe
          .mockResolvedValueOnce(me)
          .mockReturnValueOnce(wait.promise);
      const operation =
        phase === "patch" || phase === "confirm"
          ? profile.save()
          : profile.load();
      await vi.waitFor(() => {
        if (phase === "get") expect(client.getMe).toHaveBeenCalled();
        if (phase === "patch") expect(client.updateMe).toHaveBeenCalledOnce();
        if (phase === "confirm") expect(client.getMe).toHaveBeenCalledTimes(3);
      });
      profile.close();
      wait.resolve(
        phase === "prepare" ? true : { ...me, display_name: changed },
      );
      await operation;
      expect(profile.getSnapshot()).toMatchObject({
        phase: "closed",
        displayName: null,
        draft: "",
      });
      const calls = client.getMe.mock.calls.length;
      profile.invalidate();
      await profile.load();
      expect(client.getMe).toHaveBeenCalledTimes(calls);
      if (phase === "prepare" || phase === "get")
        expect(client.updateMe).not.toHaveBeenCalled();
    },
  );
  it("Auth更新後の新しいloadを古い応答が上書きしない", async () => {
    const { profile, client } = setup();
    const old = deferred<typeof me>();
    client.getMe.mockReturnValueOnce(old.promise);
    const first = profile.load();
    await vi.waitFor(() => expect(client.getMe).toHaveBeenCalledOnce());
    profile.invalidate();
    client.getMe.mockResolvedValue({ ...me, display_name: changed });
    await profile.load();
    old.resolve(me);
    await first;
    expect(profile.getSnapshot().displayName).toBe(changed);
  });
  it.each(["get", "patch"])("停止した%sを30秒で閉じる", async (phase) => {
    vi.useFakeTimers();
    const { profile, client } = setup();
    if (phase === "patch") {
      await profile.load();
      profile.edit(changed);
      client.updateMe.mockReturnValue(new Promise(() => {}));
    } else client.getMe.mockReturnValue(new Promise(() => {}));
    const operation = phase === "patch" ? profile.save() : profile.load();
    await vi.advanceTimersByTimeAsync(30_000);
    await operation;
    expect(profile.getSnapshot().phase).toBe("error");
    expect(client.getMe.mock.calls.at(-1)?.[0].aborted).toBe(true);
  });
});

describe("既定無効のUI設定", () => {
  const config = {
    KOKO_ACCOUNT_UI_ENABLED: "true",
    KOKO_API_COOKIE_ENABLED: "true",
    KOKO_API_PROXY_ENABLED: "true",
    KOKO_EVENT_ID: mockEventId,
  };
  it("3flagとevent UUIDだけを使用", () =>
    expect(accountEventId(config)).toBe(mockEventId));
  it.each(Object.keys(config))("%sが欠ける場合は無効", (key) =>
    expect(accountEventId({ ...config, [key]: undefined })).toBeNull(),
  );
  it.each(["", "true ", "TRUE", "false"])("厳密なflag判定 %s", (value) =>
    expect(
      accountEventId({ ...config, KOKO_ACCOUNT_UI_ENABLED: value }),
    ).toBeNull(),
  );
  it.each(["event", `${mockEventId}/`, ` ${mockEventId}`])(
    "不正event ID %s",
    (value) =>
      expect(accountEventId({ ...config, KOKO_EVENT_ID: value })).toBeNull(),
  );
});

describe("操作時Cookie準備", () => {
  it("固定の発行route、本文/秘密なし", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true }),
    );
    expect(await postApiSession("/auth/api-session", undefined, fetcher)).toBe(
      true,
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe("/auth/api-session");
    expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization"),
    ).toBeNull();
  });
  it("先行取消しは送信なし", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      await postApiSession("/auth/api-session", AbortSignal.abort(), fetcher),
    ).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("親の取消しで停止した通信も終了", async () => {
    const parent = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => new Promise(() => {}));
    const promise = postApiSession("/auth/api-session", parent.signal, fetcher);
    parent.abort();
    expect(await promise).toBe(false);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
