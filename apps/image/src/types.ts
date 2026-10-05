export interface Derivative {
  name: string;
  contentType: "image/jpeg" | "image/webp";
  width: number;
  height: number;
  sha256: string;
  bytes: Uint8Array;
}

export type TransformResult =
  | { ok: true; derivatives: Derivative[] }
  | {
      ok: false;
      reason:
        | "INVALID_INPUT"
        | "BUSY"
        | "TIMEOUT"
        | "DECODE_FAILED"
        | "WORKER_FAILED";
    };
