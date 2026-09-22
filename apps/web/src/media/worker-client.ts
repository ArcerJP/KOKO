import type { TrimResult, TrimTarget } from "./trim-policy";
import type { TrimRequest, TrimResponse } from "./trim.worker";

/** 1回の実行に1worker。取消しはworkerを終了し、大きなファイルでもUIを解放する。 */
export function runTrim(
  file: Blob,
  target: TrimTarget,
  signal: AbortSignal,
  onProgress: (value: number) => void,
): Promise<TrimResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./trim.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch {
      resolve({ status: "fallback", target, elapsedMs: 0, reason: "worker" });
      return;
    }
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("処理を中止しました。", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<TrimResponse>) => {
      if (data.type === "progress") onProgress(data.value);
      else {
        cleanup();
        resolve(data.result);
      }
    };
    const failed = () => {
      cleanup();
      resolve({ status: "fallback", target, elapsedMs: 0, reason: "worker" });
    };
    worker.onerror = failed;
    worker.onmessageerror = failed;
    try {
      worker.postMessage({ file, target } satisfies TrimRequest);
    } catch {
      cleanup();
      resolve({ status: "fallback", target, elapsedMs: 0, reason: "worker" });
    }
  });
}
