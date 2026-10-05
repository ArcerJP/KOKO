import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createAdminRealtime } from "../src/api/admin-realtime";

const harness = vi.hoisted(() => ({
  effect: null as null | (() => void | (() => void)),
  setters: [] as ReturnType<typeof vi.fn>[],
  createAuth: vi.fn(),
  createRealtime: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => {
    harness.effect = effect;
  },
  useState: (initial: boolean) => {
    const set = vi.fn();
    harness.setters.push(set);
    return [initial, set];
  },
}));
vi.mock("../src/auth/browser", () => ({
  createBrowserAuthClient: harness.createAuth,
}));
vi.mock("../src/api/admin-realtime", async (original) => ({
  ...(await original<typeof import("../src/api/admin-realtime")>()),
  createAdminRealtime: harness.createRealtime,
}));
import { AdminRealtimeNotice } from "../src/components/admin-realtime";

const event = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const start = vi.fn(async () => {}),
    stop = vi.fn(),
    unsubscribe = vi.fn(),
    broadcastClose = vi.fn();
  const auth = {
    auth: {
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe } },
      })),
    },
    realtime: { setAuth: vi.fn(async () => {}) },
  };
  harness.createAuth.mockReturnValue(auth);
  harness.createRealtime.mockReturnValue({ start, stop });
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
  });
  const window = new EventTarget();
  const BroadcastChannel = vi.fn(function (this: {
    onmessage: ((event: MessageEvent) => void) | null;
    close: () => void;
  }) {
    this.onmessage = null;
    this.close = broadcastClose;
  });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("BroadcastChannel", BroadcastChannel);
  const mount = (enabled = true, canReview = true) => {
    AdminRealtimeNotice({ eventId: event, enabled, canReview });
    return harness.effect!();
  };
  const dependencies = () =>
    harness.createRealtime.mock.calls[0]![1] as Parameters<
      typeof createAdminRealtime
    >[1];
  return {
    start,
    stop,
    unsubscribe,
    broadcastClose,
    auth,
    document,
    window,
    BroadcastChannel,
    mount,
    dependencies,
  };
}
beforeEach(() => {
  harness.effect = null;
  harness.setters = [];
  harness.createAuth.mockReset();
  harness.createRealtime.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  [false, true],
  [true, false],
])("inactive flags %j %j create no browser resources", (enabled, canReview) => {
  const f = fixture();
  expect(f.mount(enabled, canReview)).toBeUndefined();
  expect(harness.createAuth).not.toHaveBeenCalled();
});
it("missing auth config reports only a generic notice without throwing from effect", async () => {
  const f = fixture();
  harness.createAuth.mockImplementation(() => {
    throw new Error("private config");
  });
  const cleanup = f.mount();
  await Promise.resolve();
  expect(harness.setters[1]).toHaveBeenCalledWith(true);
  expect(harness.createRealtime).not.toHaveBeenCalled();
  if (cleanup) cleanup();
});
it("unmount suppresses late initialization failure state updates", async () => {
  const f = fixture();
  harness.createAuth.mockImplementation(() => {
    throw new Error("private config");
  });
  const cleanup = f.mount();
  if (cleanup) cleanup();
  await Promise.resolve();
  expect(harness.setters[1]).not.toHaveBeenCalled();
});
it("cross-tab protection initialization failure cleans partial resources", async () => {
  const f = fixture();
  f.BroadcastChannel.mockImplementation(() => {
    throw new Error("browser capability unavailable");
  });
  const cleanup = f.mount();
  await Promise.resolve();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(f.start).not.toHaveBeenCalled();
  expect(harness.setters[1]).toHaveBeenCalledWith(true);
  if (cleanup) cleanup();
  expect(f.stop).toHaveBeenCalledOnce();
});
it("visibility/pagehide/offline/stop and unmount stop notifications without overwriting forms", () => {
  const f = fixture();
  const cleanup = f.mount();
  expect(f.start).toHaveBeenCalledWith(true);
  f.dependencies().invalidate();
  expect(harness.setters[0]).toHaveBeenCalledWith(true);
  for (const type of ["pagehide", "offline", "koko-upload-stop"])
    f.window.dispatchEvent(new Event(type));
  f.document.visibilityState = "hidden";
  f.document.dispatchEvent(new Event("visibilitychange"));
  expect(f.stop).toHaveBeenCalledTimes(4);
  f.document.visibilityState = "visible";
  f.document.dispatchEvent(new Event("visibilitychange"));
  expect(f.start).toHaveBeenCalledTimes(2);
  if (cleanup) cleanup();
  expect(f.stop).toHaveBeenCalledTimes(5);
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(f.broadcastClose).toHaveBeenCalledOnce();
  f.window.dispatchEvent(new Event("pagehide"));
  f.document.dispatchEvent(new Event("visibilitychange"));
  f.dependencies().invalidate();
  f.dependencies().unavailable();
  expect(f.stop).toHaveBeenCalledTimes(5);
  expect(f.start).toHaveBeenCalledTimes(2);
  expect(harness.setters[0]).toHaveBeenCalledOnce();
  expect(harness.setters[1]).not.toHaveBeenCalled();
});
it("one cleanup failure cannot leave later cleanup actions active", () => {
  const f = fixture();
  const cleanup = f.mount();
  f.broadcastClose.mockImplementation(() => {
    throw new Error("fixture close");
  });
  expect(() => {
    if (cleanup) cleanup();
  }).not.toThrow();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(f.stop).toHaveBeenCalledOnce();
});
