import { describe, it, expect, vi, afterEach } from "vitest";
import {
  observeStreamOrphan,
  handleCleanupOrphansScheduled,
} from "../src/cleanup-orphans";
const event = "11111111-1111-4111-8111-111111111111",
  post = "33333333-3333-4333-8333-333333333333",
  asset = "44444444-4444-4444-8444-444444444444",
  job = "55555555-5555-4555-8555-555555555555",
  operation = "66666666-6666-4666-8666-666666666666";
const plan = {
  event_id: event,
  post_id: post,
  original_asset_id: asset,
  job_id: job,
  operation_id: operation,
  post_version: 2,
  source_uid: null,
};
const config = {
  R2_ACCOUNT_ID: "a".repeat(32),
  KOKO_DELETION_API_TOKEN: "synthetic_not_real_token",
  KOKO_EVENT_ID: event,
  KOKO_PHYSICAL_DELETION_ENABLED: "true",
};
const video = {
  uid: "b".repeat(32),
  requireSignedURLs: true,
  meta: {
    name: `koko-${operation}`,
    koko_event: event,
    koko_post: post,
    koko_asset: asset,
    koko_job: job,
    koko_version: "2",
    koko_operation: operation,
    koko_source: "original",
  },
};
const response = (result: unknown) => Response.json({ success: true, result });
afterEach(() => vi.useRealTimers());
describe("read-only orphan observation", () => {
  it("one exact match is candidate only; fixed bounded GET and no destructive method", async () => {
    const f = vi.fn().mockResolvedValue(response([video]));
    expect(await observeStreamOrphan(plan, config, f)).toEqual({
      result: "MATCHED_CANDIDATE",
      candidate_uid: video.uid,
    });
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${config.R2_ACCOUNT_ID}/stream?video_name=koko-${operation}&limit=2`,
    );
    expect(f.mock.calls[0]![1]).toMatchObject({
      method: "GET",
      redirect: "manual",
      cache: "no-store",
    });
  });
  it("empty result is NOT_FOUND not ABSENT/deleted", async () =>
    expect(
      await observeStreamOrphan(
        plan,
        config,
        vi.fn().mockResolvedValue(response([])),
      ),
    ).toEqual({ result: "NOT_FOUND", candidate_uid: null }));
  it("two candidates are duplicate even with identical metadata", async () =>
    expect(
      await observeStreamOrphan(
        plan,
        config,
        vi.fn().mockResolvedValue(response([video, video])),
      ),
    ).toEqual({ result: "DUPLICATE", candidate_uid: null }));
  for (const altered of [
    { uid: "bad" },
    { meta: {} },
    { requireSignedURLs: false },
    { clippedFrom: "c".repeat(32) },
  ])
    it(`mismatching candidate ${JSON.stringify(altered)}`, async () =>
      expect(
        await observeStreamOrphan(
          plan,
          config,
          vi.fn().mockResolvedValue(response([{ ...video, ...altered }])),
        ),
      ).toEqual({ result: "MISMATCH", candidate_uid: null }));
  for (const factory of [
    () => response([video, video, video]),
    () => Response.json({ success: false, result: [] }),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker" },
      }),
    () => Response.json({ success: true, result: [], raw: "x".repeat(65537) }),
  ])
    it("malformed/redirect/oversize never yields success", async () =>
      expect(
        await observeStreamOrphan(
          plan,
          config,
          vi.fn().mockImplementation(factory),
        ),
      ).toEqual({ result: "UNKNOWN", candidate_uid: null }));
  it("late fetch body is canceled after deadline", async () => {
    vi.useFakeTimers();
    let resolve!: (r: Response) => void;
    const f = vi.fn().mockReturnValue(
      new Promise<Response>((r) => {
        resolve = r;
      }),
    );
    const p = observeStreamOrphan(plan, config, f);
    await vi.advanceTimersByTimeAsync(10001);
    expect(await p).toEqual({ result: "UNKNOWN", candidate_uid: null });
    const canceled = vi.fn();
    resolve(
      new Response(new ReadableStream({ cancel: canceled }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(canceled).toHaveBeenCalled();
  });
  it("invalid config performs no HTTP", async () => {
    const f = vi.fn();
    expect(
      (
        await observeStreamOrphan(
          plan,
          { ...config, R2_ACCOUNT_ID: "other" },
          f,
        )
      ).result,
    ).toBe("UNKNOWN");
    expect(f).not.toHaveBeenCalled();
  });
});
describe("orphan scheduler", () => {
  it("off never touches DB/provider", async () => {
    const rpc = vi.fn(),
      f = vi.fn();
    expect(
      await handleCleanupOrphansScheduled(
        { cron: "* * * * *" },
        { ...config, KOKO_PHYSICAL_DELETION_ENABLED: "false" },
        f,
        { rpc },
      ),
    ).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });
  it("records no provider body, never returns discovered UID", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        code: "CLAIMED",
        claims: [{ plan, lease_id: operation }],
      })
      .mockResolvedValue({ code: "RECORDED" });
    const result = await handleCleanupOrphansScheduled(
      { cron: "* * * * *" },
      config,
      vi.fn().mockResolvedValue(response([video])),
      { rpc },
    );
    expect(result).toEqual({
      configured: true,
      claimed: 1,
      recorded: 1,
      failed: 0,
    });
    expect(rpc.mock.calls[1]![1]).toMatchObject({
      p_action: "record",
      p_input: { result: "MATCHED_CANDIDATE", candidate_uid: video.uid },
    });
    expect(JSON.stringify(result)).not.toContain(video.uid);
  });
  it("cross-event or duplicate batch rejected before HTTP", async () => {
    const f = vi.fn(),
      rpc = vi.fn().mockResolvedValue({
        code: "CLAIMED",
        claims: [{ plan: { ...plan, event_id: post }, lease_id: operation }],
      });
    expect(
      await handleCleanupOrphansScheduled({ cron: "* * * * *" }, config, f, {
        rpc,
      }),
    ).toMatchObject({ failed: 1, claimed: 0 });
    expect(f).not.toHaveBeenCalled();
  });
});
