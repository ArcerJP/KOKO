import { Worker } from "node:worker_threads";
import type { TransformResult } from "./types.js";
export type { Derivative, TransformResult } from "./types.js";

let active = false;

/** Local transformation only. No storage, publishing, HTTP, or credential access. */
export async function transformImage(
  input: Uint8Array,
  timeoutMs = 15_000,
): Promise<TransformResult> {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength === 0 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 15_000
  ) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  if (active) return { ok: false, reason: "BUSY" };
  active = true;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    worker = new Worker(new URL("./worker.js", import.meta.url), {
      workerData: input,
      execArgv: [],
      env: {},
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    // Discard dependency diagnostics; only the fixed result is exposed.
    worker.stdout.resume();
    worker.stderr.resume();
    return await new Promise<TransformResult>((resolve) => {
      worker!.once("message", (value: TransformResult) => resolve(value));
      worker!.once("error", () =>
        resolve({ ok: false, reason: "WORKER_FAILED" }),
      );
      worker!.once("exit", () =>
        resolve({ ok: false, reason: "WORKER_FAILED" }),
      );
      timer = setTimeout(
        () => resolve({ ok: false, reason: "TIMEOUT" }),
        timeoutMs,
      );
    });
  } catch {
    return { ok: false, reason: "WORKER_FAILED" };
  } finally {
    if (timer) clearTimeout(timer);
    // Don't free the slot until the previous decoder has actually stopped.
    try {
      await worker?.terminate();
    } finally {
      active = false;
    }
  }
}
