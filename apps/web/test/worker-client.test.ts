import { afterEach, expect, it, vi } from "vitest";
import { runTrim } from "../src/media/worker-client";

class FakeWorker {
  static last: FakeWorker;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    FakeWorker.last = this;
  }
}
afterEach(() => vi.unstubAllGlobals());

it("進捗を中継し、結果を受け取ったworkerを終了する", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const progress = vi.fn();
  const pending = runTrim(
    new Blob(["test"]),
    3.8,
    new AbortController().signal,
    progress,
  );
  FakeWorker.last.onmessage!({ data: { type: "progress", value: 0.5 } });
  FakeWorker.last.onmessage!({
    data: {
      type: "result",
      result: {
        status: "fallback",
        target: 3.8,
        elapsedMs: 1,
        reason: "unreadable",
      },
    },
  });
  expect(await pending).toMatchObject({
    status: "fallback",
    reason: "unreadable",
  });
  expect(progress).toHaveBeenCalledWith(0.5);
  expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
});
it("中止するとworkerを終了する", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const controller = new AbortController();
  const pending = runTrim(new Blob(), 3, controller.signal, vi.fn());
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
});
it("worker作成失敗・実行エラーでは原本fallbackにする", async () => {
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error("unavailable");
      }
    },
  );
  expect(
    await runTrim(new Blob(), 3, new AbortController().signal, vi.fn()),
  ).toMatchObject({ reason: "worker" });
  vi.stubGlobal("Worker", FakeWorker);
  const pending = runTrim(new Blob(), 3, new AbortController().signal, vi.fn());
  FakeWorker.last.onerror!();
  expect(await pending).toMatchObject({ reason: "worker" });
  expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
});
