import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectAdminBroadcast,
  createAdminRealtime,
  type AdminBroadcastChannel,
} from "../src/api/admin-realtime";
import type { Me } from "../src/api/client";
const event = "11111111-1111-4111-8111-111111111111";
const me: Me = {
  event_id: event,
  user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  display_name: "Fixture",
  role: "admin",
  is_banned: false,
  consent_required: false,
  terms_version: "test",
  crown: "none",
};
function fixture(value = me) {
  let notify: (payload: unknown) => void = () => {},
    disconnected: () => void = () => {};
  const close = vi.fn(),
    getMe = vi.fn().mockResolvedValue(value),
    invalidate = vi.fn(),
    unavailable = vi.fn();
  const connect = vi.fn<Parameters<typeof createAdminRealtime>[1]["connect"]>(
    async (
      topic: string,
      onMessage: (x: unknown) => void,
      onClose: () => void,
      signal: AbortSignal,
    ) => {
      expect(topic).toBe(`koko:admin:${event}`);
      expect(signal).toBeInstanceOf(AbortSignal);
      notify = onMessage;
      disconnected = onClose;
      return { close };
    },
  );
  const client = createAdminRealtime(event, {
    getMe,
    connect,
    invalidate,
    unavailable,
  });
  return {
    client,
    getMe,
    connect,
    close,
    invalidate,
    unavailable,
    notify: (value: unknown) => notify(value),
    disconnected: () => disconnected(),
  };
}
afterEach(() => vi.useRealTimers());
describe("admin-only advisory Realtime", () => {
  it("disabled does not connect or inspect identity", async () => {
    const f = fixture();
    await f.client.start(false);
    expect(f.getMe).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });
  for (const value of [
    { ...me, role: "user" as const },
    { ...me, is_banned: true },
    { ...me, consent_required: true },
    { ...me, event_id: "22222222-2222-4222-8222-222222222222" },
  ])
    it(`reject ${JSON.stringify(value)}`, async () => {
      const f = fixture(value);
      await f.client.start(true);
      expect(f.connect).not.toHaveBeenCalled();
      expect(f.unavailable).toHaveBeenCalledOnce();
    });
  it("fixed topic, minimal invalidation, no arbitrary rows", async () => {
    const f = fixture();
    await f.client.start(true);
    expect(f.connect.mock.calls[0]?.[0]).toBe(`koko:admin:${event}`);
    for (const data of [
      null,
      [],
      {},
      { changed: false },
      { changed: true, row: me },
      "invalidate",
    ])
      f.notify(data);
    expect(f.invalidate).not.toHaveBeenCalled();
    f.notify({ changed: true });
    expect(f.invalidate).toHaveBeenCalledOnce();
    f.client.stop();
  });
  it("duplicate start creates one subscription", async () => {
    const f = fixture();
    await Promise.all([f.client.start(true), f.client.start(true)]);
    expect(f.connect).toHaveBeenCalledOnce();
    f.client.stop();
  });
  it("stop closes exactly once and ignores stale callbacks", async () => {
    const f = fixture();
    await f.client.start(true);
    f.client.stop();
    f.client.stop();
    f.notify({ changed: true });
    f.disconnected();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.invalidate).not.toHaveBeenCalled();
  });
  it("late subscription closes after lifecycle stop", async () => {
    const f = fixture();
    let finish!: (x: { close: () => void }) => void;
    f.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const started = f.client.start(true);
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
    f.client.stop();
    finish({ close: f.close });
    await started;
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("connection failure is safe and permits explicit retry", async () => {
    const f = fixture();
    f.connect.mockRejectedValueOnce(new Error("private diagnostic"));
    await f.client.start(true);
    expect(f.unavailable).toHaveBeenCalledOnce();
    await f.client.start(true);
    expect(f.connect).toHaveBeenCalledTimes(2);
    f.client.stop();
  });
  for (const changed of [
    { ...me, role: "moderator" as const },
    { ...me, is_banned: true },
    { ...me, user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  ])
    it(`rechecks identity periodically ${JSON.stringify(changed)}`, async () => {
      vi.useFakeTimers();
      const f = fixture();
      await f.client.start(true);
      f.getMe.mockResolvedValueOnce(changed);
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.close).toHaveBeenCalledOnce();
      expect(f.unavailable).toHaveBeenCalledOnce();
    });
  it("stalled authorization fails closed in five seconds", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.getMe.mockImplementation(() => new Promise(() => {}));
    const started = f.client.start(true);
    await vi.advanceTimersByTimeAsync(5000);
    await started;
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.unavailable).toHaveBeenCalledOnce();
  });
  it("disabling an active subscription stops rather than leaving it live", async () => {
    const f = fixture();
    await f.client.start(true);
    await f.client.start(false);
    expect(f.close).toHaveBeenCalledOnce();
    f.notify({ changed: true });
    expect(f.invalidate).not.toHaveBeenCalled();
  });
  it("stop ends pending authorization immediately even when fetch ignores abort", async () => {
    const f = fixture();
    f.getMe.mockImplementation(() => new Promise(() => {}));
    const start = f.client.start(true);
    await Promise.resolve();
    f.client.stop();
    await start;
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.unavailable).not.toHaveBeenCalled();
  });
  it("stalled connect is bounded and late completion is removed", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: (x: { close: () => void }) => void;
    f.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const start = f.client.start(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10000);
    await start;
    expect(f.unavailable).toHaveBeenCalledOnce();
    finish({ close: f.close });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("rechecks the same identity after subscription before accepting hints", async () => {
    const f = fixture();
    f.getMe.mockResolvedValueOnce(me).mockResolvedValueOnce({
      ...me,
      user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    await f.client.start(true);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.getMe).toHaveBeenCalledTimes(2);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.unavailable).toHaveBeenCalledOnce();
  });
  it("lost callback during connect cannot overwrite a replacement lifecycle", async () => {
    const f = fixture();
    f.connect.mockImplementationOnce(async (_topic, _receive, closed) => {
      closed();
      return { close: f.close };
    });
    await f.client.start(true);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.unavailable).toHaveBeenCalledOnce();
    await f.client.start(true);
    expect(f.connect).toHaveBeenCalledTimes(2);
    f.client.stop();
  });
  it("cleanup exceptions cannot prevent identity reset or future stop", async () => {
    const f = fixture();
    f.close.mockImplementation(() => {
      throw new Error("SDK fixture");
    });
    await f.client.start(true);
    expect(() => f.client.stop()).not.toThrow();
    await f.client.start(true);
    expect(f.connect).toHaveBeenCalledTimes(2);
    f.client.stop();
  });
});

function transportFixture() {
  let status: (value: string) => void = () => {},
    receive: (value: unknown) => void = () => {};
  const close = vi.fn();
  const channel: AdminBroadcastChannel = {
    onBroadcast: vi.fn((callback) => {
      receive = callback;
    }),
    subscribe: vi.fn((callback) => {
      status = callback;
    }),
    close,
  };
  const transport = {
    setAuth: vi.fn(async () => {}),
    channel: vi.fn(() => channel),
  };
  const invalidate = vi.fn(),
    closed = vi.fn(),
    controller = new AbortController();
  const connect = () =>
    connectAdminBroadcast(
      transport,
      `koko:admin:${event}`,
      invalidate,
      closed,
      controller.signal,
    );
  return {
    transport,
    channel,
    close,
    invalidate,
    closed,
    controller,
    connect,
    status: (value: string) => status(value),
    receive: (value: unknown) => receive(value),
  };
}
describe("bounded private Broadcast adapter", () => {
  it("waits for SUBSCRIBED after auth and ignores earlier notifications", async () => {
    const f = transportFixture();
    const pending = f.connect();
    await vi.waitFor(() => expect(f.transport.channel).toHaveBeenCalledOnce());
    f.receive({ changed: true });
    expect(f.invalidate).not.toHaveBeenCalled();
    f.status("SUBSCRIBED");
    const subscription = await pending;
    f.receive({ changed: true });
    expect(f.invalidate).toHaveBeenCalledOnce();
    subscription.close();
    subscription.close();
    f.receive({ changed: true });
    f.status("CLOSED");
    expect(f.invalidate).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.closed).not.toHaveBeenCalled();
  });
  it("already aborted never starts auth or creates channel", async () => {
    const f = transportFixture();
    f.controller.abort();
    await expect(f.connect()).rejects.toThrow(/^REALTIME_UNAVAILABLE$/);
    expect(f.transport.setAuth).not.toHaveBeenCalled();
    expect(f.transport.channel).not.toHaveBeenCalled();
  });
  it("setAuth timeout cannot create a late channel", async () => {
    vi.useFakeTimers();
    const f = transportFixture();
    let finish!: () => void;
    f.transport.setAuth.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.connect();
    const rejected = expect(pending).rejects.toThrow(/^REALTIME_UNAVAILABLE$/);
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.transport.channel).not.toHaveBeenCalled();
  });
  it("stop while setAuth awaits cannot create a late channel", async () => {
    const f = transportFixture();
    let finish!: () => void;
    f.transport.setAuth.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.connect();
    const rejected = expect(pending).rejects.toThrow(/^REALTIME_UNAVAILABLE$/);
    await vi.waitFor(() => expect(f.transport.setAuth).toHaveBeenCalledOnce());
    f.controller.abort();
    await rejected;
    finish();
    await Promise.resolve();
    expect(f.transport.channel).not.toHaveBeenCalled();
  });
  it("subscription establishment timeout removes a created channel", async () => {
    vi.useFakeTimers();
    const f = transportFixture();
    const pending = f.connect();
    const rejected = expect(pending).rejects.toThrow(/^REALTIME_UNAVAILABLE$/);
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(f.close).toHaveBeenCalledOnce();
    f.status("SUBSCRIBED");
    f.receive({ changed: true });
    expect(f.invalidate).not.toHaveBeenCalled();
  });
  for (const value of ["CLOSED", "CHANNEL_ERROR", "TIMED_OUT"]) {
    it(`${value} before join rejects and removes channel`, async () => {
      const f = transportFixture();
      const pending = f.connect();
      const rejected = expect(pending).rejects.toThrow(
        /^REALTIME_UNAVAILABLE$/,
      );
      await vi.waitFor(() =>
        expect(f.transport.channel).toHaveBeenCalledOnce(),
      );
      f.status(value);
      await rejected;
      expect(f.close).toHaveBeenCalledOnce();
      expect(f.closed).not.toHaveBeenCalled();
    });
    it(`${value} after join closes and informs lifecycle once`, async () => {
      const f = transportFixture();
      const pending = f.connect();
      await vi.waitFor(() =>
        expect(f.transport.channel).toHaveBeenCalledOnce(),
      );
      f.status("SUBSCRIBED");
      await pending;
      f.status(value);
      f.status(value);
      expect(f.close).toHaveBeenCalledOnce();
      expect(f.closed).toHaveBeenCalledOnce();
    });
  }
  it("SDK initialization errors are sanitized with partial resources removed", async () => {
    const f = transportFixture();
    vi.mocked(f.channel.onBroadcast).mockImplementation(() => {
      throw new Error("private SDK diagnostic");
    });
    await expect(f.connect()).rejects.toThrow(/^REALTIME_UNAVAILABLE$/);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("invalid topic rejects before auth", async () => {
    const f = transportFixture();
    await expect(
      connectAdminBroadcast(
        f.transport,
        "koko:public:x",
        f.invalidate,
        f.closed,
        f.controller.signal,
      ),
    ).rejects.toThrow(/^REALTIME_UNAVAILABLE$/);
    expect(f.transport.setAuth).not.toHaveBeenCalled();
  });
});
