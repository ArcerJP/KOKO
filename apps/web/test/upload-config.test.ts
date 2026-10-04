import { beforeEach, expect, it, vi } from "vitest";
const { terms } = vi.hoisted(() => ({ terms: vi.fn() }));
vi.mock("../src/api/approved-terms", () => ({ getApprovedTerms: terms }));
import { uploadConfiguration } from "../src/api/upload-config";
import { accountId, eventId } from "./upload-fixture";
const configured = {
  KOKO_ACCOUNT_UI_ENABLED: "true",
  KOKO_API_COOKIE_ENABLED: "true",
  KOKO_API_PROXY_ENABLED: "true",
  KOKO_UPLOAD_PROXY_ENABLED: "true",
  KOKO_UPLOAD_UI_ENABLED: "true",
  KOKO_EVENT_ID: eventId,
  KOKO_R2_ACCOUNT_ID: accountId,
};
beforeEach(() =>
  terms.mockReturnValue({
    eventId,
    version: "synthetic-v1",
    terms: ["合成規約"],
    privacy: ["合成方針"],
  }),
);
it("projects only nonsecret configuration", () => {
  expect(
    uploadConfiguration({
      ...configured,
      KOKO_API_ACCESS_CLIENT_SECRET: "synthetic secret",
    }),
  ).toEqual({ eventId, r2AccountId: accountId, termsVersion: "synthetic-v1" });
});
it.each(Object.keys(configured))(
  "missing/invalid %s keeps UI disabled",
  (name) => {
    for (const value of [undefined, "", "FALSE", "TRUE", "invalid"])
      expect(uploadConfiguration({ ...configured, [name]: value })).toBeNull();
  },
);
it("unadopted terms never enable upload even when flags are on", () => {
  terms.mockReturnValue(null);
  expect(uploadConfiguration(configured)).toBeNull();
});
