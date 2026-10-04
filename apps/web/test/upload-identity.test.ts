import { expect, it, vi } from "vitest";
import { uploadAuthorizer } from "../src/api/upload-identity";
import type { Me } from "../src/api/client";
import { csrf, eventId } from "./upload-fixture";
const owner = "00000000-0000-4000-8000-000000000009";
const me: Me = {
  user_id: owner,
  event_id: eventId,
  display_name: "合成本人",
  role: "user",
  is_banned: false,
  consent_required: false,
  terms_version: "test-only",
  crown: "none",
  csrf_token: csrf,
};
it("prepares Cookie and rechecks Me each time without caching credentials", async () => {
  const prepare = vi.fn(async () => true),
    getMe = vi.fn(async () => me);
  const authorize = uploadAuthorizer(
    owner,
    eventId,
    "test-only",
    prepare,
    getMe,
  );
  const signal = new AbortController().signal;
  expect(await authorize(signal)).toBe(csrf);
  expect(await authorize(signal)).toBe(csrf);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(getMe).toHaveBeenCalledTimes(2);
});
it.each([
  [{ user_id: eventId }, "AUTH_REQUIRED"],
  [{ event_id: owner }, "AUTH_REQUIRED"],
  [{ is_banned: true }, "ACCOUNT_BANNED"],
  [{ consent_required: true }, "CONSENT_REQUIRED"],
  [{ terms_version: "old" }, "CONSENT_REQUIRED"],
  [{ csrf_token: undefined }, "FORBIDDEN"],
] as const)("rejects changed owner/event/guards %j", async (change, code) => {
  const authorize = uploadAuthorizer(
    owner,
    eventId,
    "test-only",
    async () => true,
    async () => ({ ...me, ...change }) as Me,
  );
  await expect(authorize(new AbortController().signal)).rejects.toMatchObject({
    code,
  });
});
it("failed prepare or abort never reads private metadata", async () => {
  const read = vi.fn(async () => me);
  const authorize = uploadAuthorizer(
    owner,
    eventId,
    "test-only",
    async () => false,
    read,
  );
  await expect(authorize(new AbortController().signal)).rejects.toMatchObject({
    code: "AUTH_REQUIRED",
  });
  const controller = new AbortController();
  controller.abort();
  await expect(authorize(controller.signal)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});
