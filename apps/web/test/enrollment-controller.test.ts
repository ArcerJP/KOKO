import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnrollmentController } from "../src/api/enrollment-controller";
const status = {
  user_id: "11111111-1111-4111-8111-111111111111",
  event_id: "22222222-2222-4222-8222-222222222222",
  enrolled: false,
  registration_open: true,
  csrf_token: "synthetic-csrf-enrollment-tests-only",
};
function setup() {
  const client = {
    getEnrollment: vi.fn().mockResolvedValue(status),
    enrollEvent: vi.fn().mockResolvedValue({ request_id: status.user_id }),
  };
  const prepare = vi.fn().mockResolvedValue(true);
  return {
    client,
    prepare,
    controller: createEnrollmentController(client, prepare),
  };
}
afterEach(() => vi.useRealTimers());
describe("初回参加controller", () => {
  it("初期化は無通信、snapshotに本人ID/CSRFを保存しない", async () => {
    const { client, prepare, controller: c } = setup();
    expect(c.getSnapshot()).toBe(c.getServerSnapshot());
    expect(prepare).not.toHaveBeenCalled();
    const listener = vi.fn();
    const unsubscribe = c.subscribe(listener);
    expect(await c.load()).toBe(false);
    expect(c.getSnapshot()).toMatchObject({
      phase: "ready",
      enrolled: false,
      open: true,
    });
    expect(Object.isFrozen(c.getSnapshot())).toBe(true);
    expect(JSON.stringify(c.getSnapshot())).not.toContain(status.user_id);
    expect(JSON.stringify(c.getSnapshot())).not.toContain(status.csrf_token);
    expect(client.enrollEvent).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
  it("prepare→read→明示編集→prepare→fresh read→POST→confirmed read", async () => {
    const { client, prepare, controller: c } = setup();
    await c.load();
    c.edit("合成試験名");
    client.getEnrollment
      .mockResolvedValueOnce({
        ...status,
        csrf_token: status.csrf_token + "fresh",
      })
      .mockResolvedValueOnce({
        ...status,
        enrolled: true,
        registration_open: false,
      });
    expect(await c.enroll()).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(client.getEnrollment).toHaveBeenCalledTimes(3);
    expect(client.enrollEvent).toHaveBeenCalledExactlyOnceWith(
      { display_name: "合成試験名" },
      status.csrf_token + "fresh",
      expect.any(AbortSignal),
    );
    expect(c.getSnapshot()).toMatchObject({
      phase: "ready",
      enrolled: true,
      draft: "",
    });
  });
  it.each(["", " ", "a".repeat(51), "x\ny", "x\u200by"])(
    "不正名はPOSTしない %j",
    async (name) => {
      const { client, controller: c } = setup();
      await c.load();
      c.edit(name);
      await c.enroll();
      expect(client.enrollEvent).not.toHaveBeenCalled();
    },
  );
  it("未確認・受付停止・既参加は登録しない", async () => {
    const { client, controller: c } = setup();
    await c.enroll();
    client.getEnrollment.mockResolvedValue({
      ...status,
      registration_open: false,
    });
    await c.load();
    c.edit("合成名");
    await c.enroll();
    client.getEnrollment.mockResolvedValue({
      ...status,
      enrolled: true,
      registration_open: false,
    });
    expect(await c.load()).toBe(true);
    c.edit("別名");
    await c.enroll();
    expect(client.enrollEvent).not.toHaveBeenCalled();
  });
  it.each([
    { user_id: "33333333-3333-4333-8333-333333333333" },
    { event_id: "44444444-4444-4444-8444-444444444444" },
    { csrf_token: undefined },
    { registration_open: false },
  ])("直前の本人/受付変更でPOST停止 %j", async (patch) => {
    const { client, controller: c } = setup();
    await c.load();
    c.edit("合成名");
    client.getEnrollment.mockResolvedValue({ ...status, ...patch });
    expect(await c.enroll()).toBe(false);
    expect(client.enrollEvent).not.toHaveBeenCalled();
    expect(c.getSnapshot().phase).toBe("error");
  });
  it("別tabの先行参加は上書きせず既参加として確認", async () => {
    const { client, controller: c } = setup();
    await c.load();
    c.edit("古い名前");
    client.getEnrollment.mockResolvedValue({
      ...status,
      enrolled: true,
      registration_open: false,
    });
    expect(await c.enroll()).toBe(true);
    expect(client.enrollEvent).not.toHaveBeenCalled();
  });
  it.each(["write", "verify", "identity"])(
    "曖昧な登録結果は自動再送せず読取りを要求 %s",
    async (mode) => {
      const { client, controller: c } = setup();
      await c.load();
      c.edit("合成名");
      if (mode === "write")
        client.enrollEvent.mockRejectedValue(new Error("secret-canary"));
      else
        client.getEnrollment
          .mockResolvedValueOnce(status)
          .mockResolvedValueOnce(
            mode === "identity"
              ? {
                  ...status,
                  user_id: "33333333-3333-4333-8333-333333333333",
                  enrolled: true,
                }
              : status,
          );
      expect(await c.enroll()).toBe(false);
      await c.enroll();
      expect(client.enrollEvent).toHaveBeenCalledOnce();
      expect(c.getSnapshot().message).toContain("再送せず");
      expect(JSON.stringify(c.getSnapshot())).not.toContain("secret-canary");
    },
  );
  it.each(["close", "invalidate"] as const)(
    "遅延読取りは%s後に表示/登録しない",
    async (kind) => {
      const { client, controller: c } = setup();
      let resolve!: (value: typeof status) => void;
      client.getEnrollment.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const pending = c.load();
      await vi.waitFor(() => expect(client.getEnrollment).toHaveBeenCalled());
      c[kind]();
      expect(await pending).toBe(false);
      resolve(status);
      await Promise.resolve();
      expect(c.getSnapshot().phase).toBe(kind === "close" ? "closed" : "idle");
      expect(client.enrollEvent).not.toHaveBeenCalled();
    },
  );
  it("30秒で中断し多重操作を送らない", async () => {
    vi.useFakeTimers();
    const { client, prepare, controller: c } = setup();
    prepare.mockImplementation(() => new Promise(() => {}));
    const pending = c.load();
    await c.load();
    await c.enroll();
    await vi.advanceTimersByTimeAsync(30000);
    expect(await pending).toBe(false);
    expect(prepare).toHaveBeenCalledOnce();
    expect(client.getEnrollment).not.toHaveBeenCalled();
    expect(c.getSnapshot().phase).toBe("error");
  });
});
