import { parentPort, workerData } from "node:worker_threads";
import { convert } from "./convert.js";
import type { TransformResult } from "./types.js";

if (!parentPort) throw new Error("WORKER_REQUIRED");
let result: TransformResult;
try {
  result = {
    ok: true,
    derivatives: await convert(Buffer.from(workerData as Uint8Array)),
  };
} catch {
  // No decoder error, filename, metadata, or input bytes cross the boundary.
  result = { ok: false, reason: "DECODE_FAILED" };
}
parentPort.postMessage(result);
