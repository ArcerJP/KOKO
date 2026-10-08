import { describe, it, expect, vi, afterEach } from "vitest";
import {
  deleteProviderAsset,
  lockAllowsDeletion,
  readDeletionPlan,
  type DeletionPlan,
  type DeletionProviderEnv,
} from "../src/deletion-provider";
import {
  handlePhysicalDeletionScheduled,
  type PhysicalDeletionEnv,
} from "../src/physical-deletion";
import type { InternalRpc } from "../src/internal-rpc";

const event = "11111111-1111-4111-8111-111111111111",
  post = "33333333-3333-4333-8333-333333333333",
  asset = "44444444-4444-4444-8444-444444444444",
  job = "55555555-5555-4555-8555-555555555555",
  lease = "66666666-6666-4666-8666-666666666666";
const plan = (): DeletionPlan => ({
  event_id: event,
  post_id: post,
  asset_id: asset,
  provider: "r2_original",
  purpose: "original",
  mode: "delete",
  object_key: `events/${event}/posts/${post}/original/${asset}.bin`,
  stream_uid: null,
  size: 100,
  etag: "a".repeat(32),
  object_version: "v1",
  sha256: null,
  upload_id: null,
  policy: { version: "synthetic" },
  stream: null,
});
const config: DeletionProviderEnv = {
  R2_ACCOUNT_ID: "a".repeat(32),
  KOKO_DELETION_API_TOKEN: "synthetic_deletion_token_not_real",
};
const head = (p = plan()) =>
  ({
    key: p.object_key,
    size: p.size,
    etag: p.etag,
    version: "v1",
    uploaded: new Date(0),
    customMetadata: { sha256: p.sha256 },
  }) as unknown as R2Object;
const json = (value: unknown, status = 200) => Response.json(value, { status });
const unlock = () => json({ success: true, result: { rules: [] } });
function bucket(p = plan()) {
  const h = vi
    .fn()
    .mockResolvedValueOnce(head(p))
    .mockResolvedValueOnce(head(p))
    .mockResolvedValue(null);
  const d = vi.fn().mockResolvedValue(undefined),
    abort = vi.fn().mockResolvedValue(undefined),
    resume = vi.fn().mockReturnValue({ abort });
  return {
    value: {
      head: h,
      delete: d,
      resumeMultipartUpload: resume,
    } as unknown as NonNullable<DeletionProviderEnv["ORIGINALS_BUCKET"]>,
    h,
    d,
    abort,
    resume,
  };
}
const check = () => vi.fn().mockResolvedValue(true);
afterEach(() => vi.useRealTimers());
describe("physical target parser", () => {
  it("accepts only reconstructed identity scoped targets", () => {
    expect(readDeletionPlan(plan())).not.toBeNull();
  });
  for (const patch of [
    { object_key: "other" },
    { event_id: "bad" },
    { provider: "other" },
    { mode: "copy" },
    { url: "https://attacker" },
    { etag: "bad" },
    { object_version: "" },
    { size: -1 },
    { stream_uid: "a".repeat(32) },
  ])
    it(`rejects ${JSON.stringify(patch)}`, () =>
      expect(readDeletionPlan({ ...plan(), ...patch })).toBeNull());
});
describe("R2 locks", () => {
  const now = 100000;
  const rule = (condition: object, prefix?: string) => ({
    id: "synthetic",
    enabled: true,
    ...(prefix === undefined ? {} : { prefix }),
    condition,
  });
  it("empty confirmed rule list allows", () =>
    expect(lockAllowsDeletion({ rules: [] }, "key", new Date(0), now)).toBe(
      true,
    ));
  for (const condition of [
    { type: "Indefinite" },
    { type: "Age", maxAgeSeconds: 101 },
    { type: "Date", date: "2026-10-20T00:00:00Z" },
    { type: "other" },
    { type: "Age", maxAgeSeconds: -1 },
  ])
    it(`blocks ${JSON.stringify(condition)}`, () =>
      expect(
        lockAllowsDeletion(
          { rules: [rule(condition)] },
          "key",
          new Date(0),
          now,
        ),
      ).toBe(false));
  it("overlapping longer lock wins", () =>
    expect(
      lockAllowsDeletion(
        {
          rules: [
            rule({ type: "Age", maxAgeSeconds: 0 }),
            rule({ type: "Indefinite" }, "ke"),
          ],
        },
        "key",
        new Date(0),
        now,
      ),
    ).toBe(false));
  it("expired lock and nonmatching prefix allow", () =>
    expect(
      lockAllowsDeletion(
        {
          rules: [
            rule({ type: "Age", maxAgeSeconds: 100 }),
            rule({ type: "Indefinite" }, "other"),
          ],
        },
        "key",
        new Date(0),
        now,
      ),
    ).toBe(true));
  for (const value of [
    null,
    {},
    { rules: [{}] },
    { rules: new Array(1001).fill({}) },
  ])
    it("unknown rules fail closed", () =>
      expect(lockAllowsDeletion(value, "key", new Date(0), now)).toBe(false));
});
describe("R2 deletion adapter", () => {
  it("rechecks identity/DB, uses fixed lock endpoint, confirms direct absence", async () => {
    const b = bucket(),
      f = vi.fn().mockImplementation(unlock),
      c = check();
    expect(
      await deleteProviderAsset(
        plan(),
        { ...config, ORIGINALS_BUCKET: b.value },
        c,
        f,
      ),
    ).toBe("ABSENT");
    expect(c).toHaveBeenCalledTimes(2);
    expect(b.h).toHaveBeenCalledTimes(3);
    expect(b.d).toHaveBeenCalledWith(plan().object_key);
    expect(String(f.mock.calls[0]![0])).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${config.R2_ACCOUNT_ID}/r2/buckets/koko-dev-originals/lock`,
    );
    expect(f.mock.calls[0]![1]).toMatchObject({
      redirect: "manual",
      cache: "no-store",
    });
  });
  it("initial absence needs current DB tombstone but no destructive IO", async () => {
    const b = bucket();
    b.h.mockReset().mockResolvedValue(null);
    const f = vi.fn();
    expect(
      await deleteProviderAsset(
        plan(),
        { ...config, ORIGINALS_BUCKET: b.value },
        check(),
        f,
      ),
    ).toBe("ABSENT");
    expect(b.d).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });
  it("DB revoked after read prevents provider delete", async () => {
    const b = bucket(),
      c = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(
      await deleteProviderAsset(
        plan(),
        { ...config, ORIGINALS_BUCKET: b.value },
        c,
        vi.fn().mockImplementation(unlock),
      ),
    ).toBe("AMBIGUOUS");
    expect(b.d).not.toHaveBeenCalled();
  });
  for (const altered of [
    { size: 99 },
    { version: "other" },
    { etag: "other" },
    { key: "other" },
  ])
    it(`identity drift ${JSON.stringify(altered)}`, async () => {
      const b = bucket();
      b.h.mockReset().mockResolvedValue({ ...head(), ...altered });
      expect(
        await deleteProviderAsset(
          plan(),
          { ...config, ORIGINALS_BUCKET: b.value },
          check(),
          vi.fn(),
        ),
      ).toBe("IDENTITY_MISMATCH");
      expect(b.d).not.toHaveBeenCalled();
    });
  it("second HEAD drift is not a compare-delete", async () => {
    const b = bucket();
    b.h
      .mockReset()
      .mockResolvedValueOnce(head())
      .mockResolvedValue({ ...head(), version: "v2" });
    expect(
      await deleteProviderAsset(
        plan(),
        { ...config, ORIGINALS_BUCKET: b.value },
        check(),
        vi.fn().mockImplementation(unlock),
      ),
    ).toBe("IDENTITY_MISMATCH");
    expect(b.d).not.toHaveBeenCalled();
  });
  for (const response of [
    () =>
      json({
        success: true,
        result: {
          rules: [
            { id: "lock", enabled: true, condition: { type: "Indefinite" } },
          ],
        },
      }),
    () => json({ success: false }, 403),
    () => json({ success: true, result: {} }),
  ])
    it("locked or unknown API permission never deletes", async () => {
      const b = bucket();
      expect(
        await deleteProviderAsset(
          plan(),
          { ...config, ORIGINALS_BUCKET: b.value },
          check(),
          vi.fn().mockImplementation(response),
        ),
      ).toBe("LOCKED");
      expect(b.d).not.toHaveBeenCalled();
    });
  it("redirect is not followed", async () => {
    const b = bucket(),
      f = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker" },
        }),
      );
    expect(
      await deleteProviderAsset(
        plan(),
        { ...config, ORIGINALS_BUCKET: b.value },
        check(),
        f,
      ),
    ).toBe("AMBIGUOUS");
    expect(f).toHaveBeenCalledTimes(1);
    expect(b.d).not.toHaveBeenCalled();
  });
  it("oversized API response is canceled", async () => {
    const b = bucket();
    expect(
      await deleteProviderAsset(
        plan(),
        { ...config, ORIGINALS_BUCKET: b.value },
        check(),
        vi.fn().mockResolvedValue(json({ data: "x".repeat(262145) })),
      ),
    ).toBe("AMBIGUOUS");
    expect(b.d).not.toHaveBeenCalled();
  });
  it("delete timeout remains ambiguous, no fabricated receipt", async () => {
    const b = bucket();
    b.d.mockRejectedValue(new Error("sensitive provider body"));
    expect(
      await deleteProviderAsset(
        plan(),
        { ...config, ORIGINALS_BUCKET: b.value },
        check(),
        vi.fn().mockImplementation(unlock),
      ),
    ).toBe("AMBIGUOUS");
  });
  it("late HEAD after wall deadline cannot trigger delete", async () => {
    vi.useFakeTimers();
    const b = bucket();
    let resolve!: (v: R2Object) => void;
    b.h.mockReset().mockReturnValue(
      new Promise<R2Object>((r) => {
        resolve = r;
      }),
    );
    const work = deleteProviderAsset(
      plan(),
      { ...config, ORIGINALS_BUCKET: b.value },
      check(),
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(60001);
    expect(await work).toBe("AMBIGUOUS");
    resolve(head());
    await Promise.resolve();
    expect(b.d).not.toHaveBeenCalled();
  });
  it("initial ready expired multipart abort is exact provider id and never object delete", async () => {
    const b = bucket();
    b.h.mockReset().mockResolvedValue(null);
    const p = {
      ...plan(),
      mode: "abort_multipart" as const,
      upload_id: "exact-provider",
      etag: null,
      object_version: null,
    };
    expect(
      await deleteProviderAsset(
        p,
        { ...config, ORIGINALS_BUCKET: b.value },
        check(),
        vi.fn(),
      ),
    ).toBe("ABSENT");
    expect(b.resume).toHaveBeenCalledWith(p.object_key, "exact-provider");
    expect(b.abort).toHaveBeenCalledTimes(1);
    expect(b.d).not.toHaveBeenCalled();
  });
  it("multipart unexpected object forbids abort", async () => {
    const b = bucket(),
      p = {
        ...plan(),
        mode: "abort_multipart" as const,
        upload_id: "exact-provider",
        etag: null,
        object_version: null,
      };
    expect(
      await deleteProviderAsset(
        p,
        { ...config, ORIGINALS_BUCKET: b.value },
        check(),
        vi.fn(),
      ),
    ).toBe("IDENTITY_MISMATCH");
    expect(b.abort).not.toHaveBeenCalled();
  });
  it("derived requires receipt hash and correct fixed bucket", async () => {
    const p = {
      ...plan(),
      provider: "r2_delivery" as const,
      purpose: "delivery_600_webp",
      object_key: `events/${event}/delivery/${asset}/600.webp`,
      sha256: "b".repeat(64),
      etag: null,
      object_version: null,
    };
    const b = bucket(p),
      f = vi.fn().mockImplementation(unlock);
    expect(
      await deleteProviderAsset(
        p,
        { ...config, DERIVED_BUCKET: b.value },
        check(),
        f,
      ),
    ).toBe("ABSENT");
    expect(String(f.mock.calls[0]![0])).toContain("koko-dev-derived/lock");
  });
});
function streamPlan(): DeletionPlan {
  return {
    ...plan(),
    provider: "stream",
    purpose: "stream_source",
    object_key: null,
    stream_uid: "b".repeat(32),
    size: null,
    etag: null,
    object_version: null,
    stream: {
      operation_id: lease,
      job_id: job,
      post_version: 2,
      original_asset_id: asset,
      source_uid: null,
    },
  };
}
function video(p = streamPlan()) {
  return {
    uid: p.stream_uid,
    requireSignedURLs: true,
    meta: {
      name: `koko-${lease}`,
      koko_event: event,
      koko_post: post,
      koko_asset: asset,
      koko_job: job,
      koko_version: "2",
      koko_operation: lease,
      koko_source: "original",
    },
  };
}
describe("Stream deletion", () => {
  it("known UID metadata + parent, DELETE, absence via detail and fixed name query", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ success: true, result: video() }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ success: false }, 404))
      .mockResolvedValueOnce(json({ success: true, result: [] }));
    expect(await deleteProviderAsset(streamPlan(), config, check(), f)).toBe(
      "ABSENT",
    );
    expect(f.mock.calls[1]![1].method).toBe("DELETE");
    expect(String(f.mock.calls[3]![0])).toContain(
      `video_name=koko-${lease}&limit=2`,
    );
  });
  for (const altered of [
    { uid: "c".repeat(32) },
    { requireSignedURLs: false },
    { meta: {} },
    { clippedFrom: "c".repeat(32) },
  ])
    it(`different provider identity ${JSON.stringify(altered)}`, async () => {
      const f = vi
        .fn()
        .mockResolvedValue(
          json({ success: true, result: { ...video(), ...altered } }),
        );
      expect(await deleteProviderAsset(streamPlan(), config, check(), f)).toBe(
        "IDENTITY_MISMATCH",
      );
      expect(f).toHaveBeenCalledTimes(1);
    });
  it("404 alone is not absence proof", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ success: false }, 404))
      .mockResolvedValueOnce(json({ success: true, result: [video()] }));
    expect(
      await deleteProviderAsset(streamPlan(), config, check(), f),
    ).not.toBe("ABSENT");
  });
  it("DELETE success without subsequent absence is ambiguous", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ success: true, result: video() }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValue(json({ success: true, result: video() }));
    expect(await deleteProviderAsset(streamPlan(), config, check(), f)).toBe(
      "AMBIGUOUS",
    );
  });
});
describe("bounded scheduled dispatch", () => {
  const env: PhysicalDeletionEnv = {
    ...config,
    KOKO_EVENT_ID: event,
    KOKO_PHYSICAL_DELETION_ENABLED: "true",
  };
  it("default OFF performs no RPC or HTTP", async () => {
    const rpc = vi.fn(),
      fetcher = vi.fn();
    expect(
      await handlePhysicalDeletionScheduled(
        { cron: "* * * * *" },
        { ...env, KOKO_PHYSICAL_DELETION_ENABLED: "false" },
        fetcher,
        { rpc },
      ),
    ).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("unconfigured never claims", async () => {
    const rpc = vi.fn();
    expect(
      await handlePhysicalDeletionScheduled(
        { cron: "* * * * *" },
        { ...env, KOKO_DELETION_API_TOKEN: "" },
        vi.fn(),
        { rpc },
      ),
    ).toMatchObject({ configured: false, claimed: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("DB held causes no external calls", async () => {
    const rpc: InternalRpc = vi
        .fn()
        .mockResolvedValueOnce({
          code: "CLAIMED",
          jobs: [{ event_id: event, job_id: job, lease_id: lease }],
          held: 0,
        })
        .mockResolvedValueOnce({ code: "HELD" })
        .mockResolvedValue({ code: "CLAIMED", jobs: [], held: 0 }),
      f = vi.fn();
    expect(
      await handlePhysicalDeletionScheduled({ cron: "* * * * *" }, env, f, {
        rpc,
      }),
    ).toMatchObject({ claimed: 1, held: 1, done: 0 });
    expect(f).not.toHaveBeenCalled();
  });
  it("scope mismatch batch is rejected before preparing anything", async () => {
    const rpc = vi.fn().mockResolvedValue({
      code: "CLAIMED",
      jobs: [{ event_id: post, job_id: job, lease_id: lease }],
      held: 0,
    });
    expect(
      await handlePhysicalDeletionScheduled(
        { cron: "* * * * *" },
        env,
        vi.fn(),
        { rpc },
      ),
    ).toMatchObject({ failed: 1, claimed: 0 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("full mock pipeline sends only bounded receipt, no raw provider details", async () => {
    const b = bucket();
    b.h.mockReset().mockResolvedValue(null);
    let completed = false;
    const rpc = vi
      .fn()
      .mockImplementation(async (_name: string, args: { p_action: string }) => {
        switch (args.p_action) {
          case "claim":
            return {
              code: "CLAIMED",
              jobs: completed
                ? []
                : [{ event_id: event, job_id: job, lease_id: lease }],
              held: 0,
            };
          case "prepare":
            return { code: "PREPARED", plan: plan() };
          case "begin":
            return { code: "CURRENT" };
          default:
            completed = true;
            return { code: "DONE" };
        }
      });
    expect(
      await handlePhysicalDeletionScheduled(
        { cron: "* * * * *" },
        { ...env, ORIGINALS_BUCKET: b.value },
        vi.fn(),
        { rpc },
      ),
    ).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect(
      rpc.mock.calls.find((call) => call[1].p_action === "settle")![1],
    ).toMatchObject({
      p_action: "settle",
      p_input: { result: "ABSENT" },
    });
    for (const call of rpc.mock.calls.filter(
      (call) => call[1].p_action === "claim",
    ))
      expect(call[1]).toMatchObject({ p_input: { limit: 1 } });
  });
  it("does not preclaim the next lease while the first provider HEAD waits", async () => {
    vi.useFakeTimers();
    const b = bucket();
    let release!: () => void;
    b.h.mockReset().mockReturnValue(
      new Promise<null>((resolve) => {
        release = () => resolve(null);
      }),
    );
    let settled = false;
    const rpc = vi
      .fn()
      .mockImplementation(async (_name: string, args: { p_action: string }) => {
        if (args.p_action === "claim")
          return {
            code: "CLAIMED",
            held: 0,
            jobs: settled
              ? []
              : [{ event_id: event, job_id: job, lease_id: lease }],
          };
        if (args.p_action === "prepare")
          return { code: "PREPARED", plan: plan() };
        if (args.p_action === "begin") return { code: "CURRENT" };
        settled = true;
        return { code: "DONE" };
      });
    const work = handlePhysicalDeletionScheduled(
      { cron: "* * * * *" },
      { ...env, ORIGINALS_BUCKET: b.value },
      vi.fn(),
      { rpc },
    );
    await vi.advanceTimersByTimeAsync(55000);
    expect(
      rpc.mock.calls.filter((c) => c[1].p_action === "claim"),
    ).toHaveLength(1);
    release();
    expect(await work).toMatchObject({ done: 1, claimed: 1, failed: 0 });
    expect(
      rpc.mock.calls.filter((c) => c[1].p_action === "claim"),
    ).toHaveLength(2);
  });
});
