import type { CloudRunClient, ProcessingJob } from "./cloud-run-client.js";

export const relayPath = "/api/internal/media/process";
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
export const processingId = (x: unknown): x is string =>
  typeof x === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    x,
  );
export function processingJob(x: unknown): ProcessingJob | null {
  return object(x) &&
    Object.keys(x).length === 3 &&
    [x.eventId, x.postId, x.jobId].every(processingId)
    ? Object.freeze({
        eventId: x.eventId as string,
        postId: x.postId as string,
        jobId: x.jobId as string,
      })
    : null;
}
export const relayOrigin = (x: unknown): x is string =>
  typeof x === "string" &&
  x.length <= 253 &&
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(x);
export const relaySecret = (x: unknown): x is string =>
  typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
const error = () => new Error("PROCESSING_RELAY_UNAVAILABLE");
export async function relayBounded<T>(
  ms: number,
  outer: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((reason: Error) => void) | undefined;
  const abort = () => {
    controller.abort();
    rejectAbort?.(error());
  };
  outer?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        rejectAbort = reject;
        timer = setTimeout(abort, ms);
        if (outer?.aborted) abort();
      }),
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw error();
        return operation(controller.signal);
      }),
    ]);
  } catch {
    throw error();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer?.removeEventListener("abort", abort);
    controller.abort();
  }
}
export async function relayBody(
  input: Request | Response,
  signal: AbortSignal,
): Promise<string> {
  const reader = input.body?.getReader();
  const cancel = () => {
    void reader?.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const length = input.headers.get("content-length");
    if (
      !reader ||
      signal.aborted ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        input.headers.get("content-type") ?? "",
      ) ||
      (input.headers.has("content-encoding") &&
        input.headers.get("content-encoding") !== "identity") ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > 512))
    )
      throw error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (signal.aborted) throw error();
      if (next.done) break;
      size += next.value.length;
      if (size > 512) throw error();
      chunks.push(next.value);
    }
    if (length !== null && Number(length) !== size) throw error();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}
const material = (origin: string, at: string, nonce: string, body: string) =>
  new TextEncoder().encode(
    `koko-processing-relay-v1\nPOST\n${origin}\n${relayPath}\n${at}\n${nonce}\n${body}`,
  );
const key = (secret: string, usage: KeyUsage) =>
  crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret.match(/.{2}/g)!, (part) => parseInt(part, 16)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
export async function signRelay(
  origin: string,
  secret: string,
  body: string,
  at: string,
  nonce: string,
): Promise<Headers> {
  if (
    !relayOrigin(origin) ||
    !relaySecret(secret) ||
    !/^\d{13}$/.test(at) ||
    !processingId(nonce)
  )
    throw error();
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await key(secret, "sign"),
      material(origin, at, nonce, body),
    ),
  );
  return new Headers({
    "content-type": "application/json",
    accept: "application/json",
    "accept-encoding": "identity",
    "x-koko-relay-at": at,
    "x-koko-relay-nonce": nonce,
    "x-koko-relay-signature": Array.from(signature, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
  });
}
export async function verifyRelay(
  request: Request,
  origin: string,
  secret: string,
  body: string,
): Promise<boolean> {
  const at = request.headers.get("x-koko-relay-at") ?? "";
  const nonce = request.headers.get("x-koko-relay-nonce") ?? "";
  const signature = request.headers.get("x-koko-relay-signature") ?? "";
  if (
    !relayOrigin(origin) ||
    !relaySecret(secret) ||
    !/^\d{13}$/.test(at) ||
    Math.abs(Date.now() - Number(at)) > 60000 ||
    !processingId(nonce) ||
    !/^[0-9a-f]{64}$/.test(signature)
  )
    return false;
  return crypto.subtle.verify(
    "HMAC",
    await key(secret, "verify"),
    Uint8Array.from(signature.match(/.{2}/g)!, (part) => parseInt(part, 16)),
    material(origin, at, nonce, body),
  );
}
export function createProcessingRelayClient(
  options: {
    enabled?: boolean;
    origin?: string;
    secret?: string;
    eventId?: string;
    protectionBypass?: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): CloudRunClient | null {
  if (options.enabled !== true) return null;
  const {
    origin,
    secret,
    eventId,
    protectionBypass,
    fetcher = fetch,
    timeoutMs = 150000,
  } = options;
  if (
    !relayOrigin(origin) ||
    !relaySecret(secret) ||
    !processingId(eventId) ||
    typeof fetcher !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 150000 ||
    (protectionBypass !== undefined &&
      !/^[A-Za-z0-9._~-]{32,2048}$/.test(protectionBypass))
  )
    throw new Error("INVALID_PROCESSING_RELAY_CONFIG");
  const endpoint = `${origin}${relayPath}`;
  return Object.freeze({
    async process(
      value: ProcessingJob,
      signal?: AbortSignal,
    ): Promise<boolean> {
      const job = processingJob(value);
      if (!job || job.eventId !== eventId) throw error();
      return relayBounded(timeoutMs, signal, async (active) => {
        const body = JSON.stringify(job);
        const headers = await signRelay(
          origin,
          secret,
          body,
          String(Date.now()),
          crypto.randomUUID(),
        );
        if (protectionBypass)
          headers.set("x-vercel-protection-bypass", protectionBypass);
        if (active.aborted) throw error();
        const response = await fetcher(endpoint, {
          method: "POST",
          redirect: "manual",
          cache: "no-store",
          signal: active,
          headers,
          body,
        });
        if (active.aborted) {
          void response.body?.cancel().catch(() => {});
          throw error();
        }
        if (
          response.status !== 200 ||
          response.redirected ||
          (response.url && response.url !== endpoint)
        ) {
          void response.body?.cancel().catch(() => {});
          throw error();
        }
        const result: unknown = JSON.parse(await relayBody(response, active));
        if (
          !object(result) ||
          Object.keys(result).length !== 2 ||
          result.processComplete !== true ||
          result.stage !== "moderation"
        )
          throw error();
        return true;
      });
    },
  });
}
