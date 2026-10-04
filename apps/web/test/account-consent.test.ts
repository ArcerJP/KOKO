import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountProfile } from "../src/api/account-profile";
import { createApiClient } from "../src/api/client";
import { copyTermsDocument } from "../src/api/terms-document";
import { getApprovedTerms } from "../src/api/approved-terms";
import { mockMe } from "../src/mocks/handlers";
import { syntheticTerms } from "./consent-fixture";

const csrf = "synthetic-fresh-consent-csrf-0000000001";
const me = { ...mockMe, csrf_token: csrf };
const ack = { request_id: "00000000-0000-4000-8000-000000000003" };
function setup(doc = syntheticTerms) {
  const client = {
    getMe: vi.fn().mockResolvedValue(me),
    updateMe: vi.fn().mockResolvedValue(ack),
    acceptTerms: vi.fn().mockResolvedValue(ack),
  };
  const prepare = vi.fn().mockResolvedValue(true);
  const profile = createAccountProfile(client, prepare, doc);
  return { client, prepare, profile };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe("採択本文の境界", () => {
  it("production一覧は空、未知event・重複・不正本文を拒否", () => {
    expect(getApprovedTerms(syntheticTerms.eventId)).toBeNull();
    expect(getApprovedTerms("unknown", [syntheticTerms])).toBeNull();
    expect(
      getApprovedTerms(syntheticTerms.eventId, [
        syntheticTerms,
        syntheticTerms,
      ]),
    ).toBeNull();
    expect(
      getApprovedTerms(syntheticTerms.eventId, [
        { ...syntheticTerms, privacy: [] },
      ]),
    ).toBeNull();
    expect(getApprovedTerms(syntheticTerms.eventId, [syntheticTerms])).toEqual(
      syntheticTerms,
    );
  });
  it.each([
    null,
    [],
    {},
    { ...syntheticTerms, extra: true },
    { ...syntheticTerms, eventId: "not-uuid" },
    { ...syntheticTerms, version: " " },
    { ...syntheticTerms, version: "x\n" },
    { ...syntheticTerms, version: "x".repeat(129) },
    { ...syntheticTerms, terms: [] },
    { ...syntheticTerms, privacy: [" "] },
    { ...syntheticTerms, privacy: [1] },
    { ...syntheticTerms, terms: Array<string>(1) },
    { ...syntheticTerms, terms: Array.from({ length: 129 }, () => "a") },
    { ...syntheticTerms, terms: ["あ".repeat(50_000)] },
  ])("不正/過大の文書 %#", (doc) => expect(copyTermsDocument(doc)).toBeNull());
  it("不変コピーで呼出し元の後の変更から分離", () => {
    const source = { ...syntheticTerms, terms: ["original"] };
    const copy = copyTermsDocument(source)!;
    source.terms[0] = "replaced";
    source.version = "new";
    expect(copy.terms).toEqual(["original"]);
    expect(copy.version).toBe("test-only");
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.terms)).toBe(true);
    expect(Object.isFrozen(copy.privacy)).toBe(true);
  });
});

describe("明示同意controller", () => {
  it("読込み/チェックだけで送信せず、未チェックは拒否", async () => {
    const { profile, client, prepare } = setup();
    profile.checkConsent(true);
    await profile.accept();
    expect(prepare).not.toHaveBeenCalled();
    await profile.load();
    expect(profile.getSnapshot().consentChecked).toBe(false);
    await profile.accept();
    profile.checkConsent(true);
    expect(client.acceptTerms).not.toHaveBeenCalled();
    profile.checkConsent(false);
    await profile.accept();
    expect(client.acceptTerms).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledOnce();
  });
  it("実clientで明示POST→再GET。同じ版・fresh CSRFのみを送る", async () => {
    const order: string[] = [];
    let accepted = false;
    let version = 0;
    const client = createApiClient(
      new URL("https://web.example.test/api/"),
      syntheticTerms.eventId,
      async (url, init) => {
        if (init?.method === "POST") {
          expect(new URL(String(url)).pathname).toBe("/api/consents");
          expect(init.credentials).toBe("same-origin");
          expect(init.redirect).toBe("error");
          expect(new Headers(init.headers).get("X-CSRF-Token")).toBe(
            `${csrf}-${version}`,
          );
          expect(JSON.parse(String(init.body))).toEqual({
            terms_version: "test-only",
            accepted: true,
          });
          accepted = true;
          order.push("POST");
          return Response.json(ack);
        }
        order.push("GET");
        return Response.json({
          ...me,
          csrf_token: `${csrf}-${++version}`,
          consent_required: !accepted,
        });
      },
    );
    const profile = createAccountProfile(
      client,
      async () => {
        order.push("prepare");
        return true;
      },
      syntheticTerms,
    );
    await profile.load();
    profile.checkConsent(true);
    await profile.accept();
    expect(order).toEqual(["prepare", "GET", "prepare", "GET", "POST", "GET"]);
    expect(profile.getSnapshot()).toMatchObject({
      phase: "ready",
      consentRequired: false,
      consentChecked: false,
      error: false,
    });
    expect(profile.getSnapshot().message).toContain("保存し");
    expect(JSON.stringify(profile.getSnapshot())).not.toContain(csrf);
    await profile.accept();
    expect(order).toHaveLength(6);
  });
  it.each(["absent", "version", "event", "no-client"])(
    "未設定/不一致の%sでは送信なし",
    async (mode) => {
      const { client, prepare } = setup();
      const profile = createAccountProfile(
        mode === "no-client"
          ? { getMe: client.getMe, updateMe: client.updateMe }
          : client,
        prepare,
        mode === "absent"
          ? null
          : {
              ...syntheticTerms,
              ...(mode === "version" ? { version: "other" } : {}),
              ...(mode === "event"
                ? { eventId: "11111111-1111-4111-8111-111111111111" }
                : {}),
            },
      );
      await profile.load();
      profile.checkConsent(true);
      await profile.accept();
      expect(client.acceptTerms).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { terms_version: "new" },
    { user_id: "other" },
    { event_id: "other" },
    { csrf_token: undefined },
  ])("直前の版/本人/CSRF変更を拒否 %#", async (patch) => {
    const { profile, client } = setup();
    await profile.load();
    profile.checkConsent(true);
    client.getMe.mockResolvedValue({ ...me, ...patch });
    await profile.accept();
    expect(client.acceptTerms).not.toHaveBeenCalled();
    expect(profile.getSnapshot()).toMatchObject({
      phase: "error",
      terms: null,
      consentChecked: false,
    });
  });
  it("別操作で既に同意済みならPOSTせず状態を確認", async () => {
    const { profile, client } = setup();
    await profile.load();
    profile.checkConsent(true);
    client.getMe.mockResolvedValue({ ...me, consent_required: false });
    await profile.accept();
    expect(client.acceptTerms).not.toHaveBeenCalled();
    expect(profile.getSnapshot()).toMatchObject({
      consentRequired: false,
      consentChecked: false,
    });
  });
  it("BAN中の同意は投稿制限を解除しない", async () => {
    const { profile, client } = setup();
    client.getMe.mockResolvedValue({ ...me, is_banned: true });
    await profile.load();
    profile.checkConsent(true);
    client.getMe
      .mockResolvedValueOnce({ ...me, is_banned: true })
      .mockResolvedValueOnce({
        ...me,
        is_banned: true,
        consent_required: false,
      });
    await profile.accept();
    expect(profile.getSnapshot()).toMatchObject({
      blocked: true,
      consentRequired: false,
    });
    profile.edit("change");
    await profile.save();
    expect(client.updateMe).not.toHaveBeenCalled();
  });
  it.each([
    "prepare",
    "pre-get",
    "post",
    "confirm-get",
    "required",
    "new-version",
    "other-user",
    "other-event",
  ])("途中失敗/確認不一致は結果不明・再送なし %s", async (mode) => {
    const { profile, client, prepare } = setup();
    await profile.load();
    profile.checkConsent(true);
    if (mode === "prepare") prepare.mockResolvedValue(false);
    else if (mode === "pre-get")
      client.getMe.mockRejectedValueOnce(new Error("private-canary"));
    else if (mode === "post")
      client.acceptTerms.mockRejectedValueOnce(new Error("private-canary"));
    else {
      client.getMe.mockResolvedValueOnce(me);
      if (mode === "confirm-get")
        client.getMe.mockRejectedValueOnce(new Error("private-canary"));
      else
        client.getMe.mockResolvedValueOnce({
          ...me,
          consent_required: mode === "required",
          ...(mode === "new-version" ? { terms_version: "next" } : {}),
          ...(mode === "other-user" ? { user_id: "other" } : {}),
          ...(mode === "other-event" ? { event_id: "other" } : {}),
        });
    }
    await profile.accept();
    expect(profile.getSnapshot()).toMatchObject({
      phase: "error",
      terms: null,
      consentChecked: false,
      displayName: null,
    });
    expect(profile.getSnapshot().message).toContain("再送せず");
    expect(JSON.stringify(profile.getSnapshot())).not.toContain(
      "private-canary",
    );
    const count = client.acceptTerms.mock.calls.length;
    await profile.accept();
    expect(client.acceptTerms).toHaveBeenCalledTimes(count);
  });
  it("二重押下と表示名/読込みの同時操作を拒否", async () => {
    const { profile, client } = setup();
    await profile.load();
    profile.checkConsent(true);
    const pending = deferred<typeof ack>();
    client.acceptTerms.mockReturnValueOnce(pending.promise);
    client.getMe
      .mockResolvedValueOnce(me)
      .mockResolvedValueOnce({ ...me, consent_required: false });
    const saving = profile.accept();
    await vi.waitFor(() => expect(client.acceptTerms).toHaveBeenCalledOnce());
    await profile.accept();
    await profile.load();
    await profile.save();
    profile.checkConsent(true);
    expect(profile.getSnapshot()).toMatchObject({
      phase: "consenting",
      consentChecked: false,
    });
    pending.resolve(ack);
    await saving;
    expect(client.acceptTerms).toHaveBeenCalledOnce();
    expect(client.updateMe).not.toHaveBeenCalled();
    expect(client.getMe).toHaveBeenCalledTimes(3);
  });
  it.each(["prepare", "get", "post", "confirm"])(
    "終了後の遅延%sは復活/次要求なし",
    async (phase) => {
      const { profile, client, prepare } = setup();
      await profile.load();
      profile.checkConsent(true);
      const waiting = deferred<unknown>();
      if (phase === "prepare") prepare.mockReturnValueOnce(waiting.promise);
      if (phase === "get") client.getMe.mockReturnValueOnce(waiting.promise);
      if (phase === "post")
        client.acceptTerms.mockReturnValueOnce(waiting.promise);
      if (phase === "confirm")
        client.getMe
          .mockResolvedValueOnce(me)
          .mockReturnValueOnce(waiting.promise);
      const operation = profile.accept();
      await vi.waitFor(() => {
        if (phase === "get") expect(client.getMe).toHaveBeenCalledTimes(2);
        if (phase === "post") expect(client.acceptTerms).toHaveBeenCalledOnce();
        if (phase === "confirm") expect(client.getMe).toHaveBeenCalledTimes(3);
      });
      profile.close();
      const count = client.getMe.mock.calls.length;
      waiting.resolve(
        phase === "prepare" ? true : { ...me, consent_required: false },
      );
      await operation;
      expect(profile.getSnapshot()).toMatchObject({
        phase: "closed",
        terms: null,
        consentChecked: false,
      });
      expect(client.getMe).toHaveBeenCalledTimes(count);
      if (phase === "get" || phase === "prepare")
        expect(client.acceptTerms).not.toHaveBeenCalled();
    },
  );
  it("Auth更新と再読込みはチェックを引き継がない", async () => {
    const { profile } = setup();
    await profile.load();
    profile.checkConsent(true);
    profile.invalidate();
    expect(profile.getSnapshot().consentChecked).toBe(false);
    await profile.load();
    expect(profile.getSnapshot().consentChecked).toBe(false);
  });
  it("停止したPOSTを30秒で打切り成功にしない", async () => {
    vi.useFakeTimers();
    const { profile, client } = setup();
    await profile.load();
    profile.checkConsent(true);
    client.acceptTerms.mockReturnValue(new Promise(() => {}));
    const operation = profile.accept();
    await vi.advanceTimersByTimeAsync(30_000);
    await operation;
    expect(profile.getSnapshot()).toMatchObject({
      phase: "error",
      consentChecked: false,
    });
    expect(client.acceptTerms.mock.calls[0]?.[2].aborted).toBe(true);
  });
});
