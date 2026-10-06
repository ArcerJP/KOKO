import { afterEach, expect, it, vi } from "vitest";
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn(() => {
    throw new Error("FEED_REDIRECT");
  }),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("../src/components/capture-lab", () => ({ CaptureLab: () => null }));
import Home from "../src/app/page";
import CaptureLabPage from "../src/app/capture-lab/page";
import { CaptureLab } from "../src/components/capture-lab";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it.each([undefined, "false", "TRUE"])(
  "keeps local lab with feed flag %s",
  (flag) => {
    vi.stubEnv("KOKO_PUBLIC_FEED_ENABLED", flag);
    expect(Home().type).toBe(CaptureLab);
    expect(redirect).not.toHaveBeenCalled();
  },
);
it("redirects only a configured enabled app to authenticated feed", () => {
  for (const flag of [
    "KOKO_PUBLIC_FEED_ENABLED",
    "KOKO_ACCOUNT_UI_ENABLED",
    "KOKO_API_COOKIE_ENABLED",
    "KOKO_API_PROXY_ENABLED",
  ])
    vi.stubEnv(flag, "true");
  vi.stubEnv("KOKO_EVENT_ID", "00000000-0000-4000-8000-000000000001");
  expect(() => Home()).toThrow("FEED_REDIRECT");
  expect(redirect).toHaveBeenCalledWith("/feed");
  expect(CaptureLabPage().type).toBe(CaptureLab);
});
it("invalid event never activates app entry", () => {
  vi.stubEnv("KOKO_PUBLIC_FEED_ENABLED", "true");
  vi.stubEnv("KOKO_EVENT_ID", "bad");
  expect(Home().type).toBe(CaptureLab);
  expect(redirect).not.toHaveBeenCalled();
});
