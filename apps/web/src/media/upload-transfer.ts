import { ApiFailure } from "../api/client";
import type { UploadCheckpoint } from "./upload-queue-record";
import {
  completion,
  signedPut,
  ticket,
  tickets,
  uploadRequest,
  type CompleteUpload,
  type PartTickets,
  type UploadDestination,
  type UploadRequest,
  type UploadTicket,
} from "../api/upload-contract";

type Part = NonNullable<CompleteUpload["parts"]>[number];
type Options = {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  // Caller refreshes API Cookie + CSRF as needed; neither is sent to R2.
  signParts: (numbers: number[], signal?: AbortSignal) => Promise<PartTickets>;
  checkpoint?: UploadCheckpoint | null;
  onPart?: (part: Part, identity: string) => void | Promise<void>;
};

/** Transfer only. The caller separately submits the returned manifest to complete.
 * No automatic retry: a failed/aborted PUT may already have been stored.
 */
export async function transferOriginal(
  blob: Blob,
  input: UploadRequest,
  upload: UploadTicket,
  destination: UploadDestination,
  options: Options,
): Promise<CompleteUpload> {
  const { signal, fetcher = fetch } = options;
  signal?.throwIfAborted();
  const request = uploadRequest(input);
  // Snapshot mutable caller objects before the first await.
  const scope = { ...destination };
  const session = ticket(upload, scope, Date.now());
  if (
    !(blob instanceof Blob) ||
    blob.size !== request.file_size_bytes ||
    (session.mode === "single" &&
      session.required_headers?.["content-type"] !== request.content_type)
  )
    throw new ApiFailure("INVALID_INPUT");

  async function put(
    url: URL,
    body: Blob,
    headers: Record<string, string>,
    multipart: boolean,
  ): Promise<string | undefined> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 120_000);
    try {
      const response = await fetcher(url, {
        method: "PUT",
        body,
        headers,
        mode: "cors",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      void response.body?.cancel().catch(() => {});
      signal?.throwIfAborted();
      if (controller.signal.aborted)
        throw new ApiFailure("NETWORK_UNAVAILABLE");
      if (response.redirected || response.status !== 200)
        throw new ApiFailure(
          response.status === 412 ? "STATE_CONFLICT" : "UPLOAD_INCOMPLETE",
        );
      if (!multipart) return undefined;
      const etag = response.headers.get("etag");
      if (!etag || !/^(?:[0-9a-f]{32}|"[0-9a-f]{32}")$/.test(etag))
        throw new ApiFailure("UPLOAD_INCOMPLETE");
      return etag.replaceAll('"', "");
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure("NETWORK_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  if (session.mode === "single") {
    // Recheck expiry at use, not only at API receipt time.
    ticket(session, scope, Date.now());
    await put(
      signedPut(
        session.put_url,
        session.expires_at,
        scope,
        undefined,
        session.post_id,
      ),
      blob,
      session.required_headers!,
      false,
    );
    return { upload_id: session.upload_id };
  }
  const size = session.part_size_bytes!;
  const count = Math.ceil(blob.size / size);
  if (count < 1 || count > 10000) throw new ApiFailure("INVALID_INPUT");
  const checkpoint = options.checkpoint;
  const parts: Part[] = checkpoint
    ? completion({ upload_id: session.upload_id, parts: checkpoint.parts })
        .parts!
    : [];
  if (
    parts.length > count ||
    (checkpoint && !/^[a-f0-9]{64}$/.test(checkpoint.identity))
  )
    throw new ApiFailure("INVALID_INPUT");
  let identity = checkpoint?.identity;
  // Sign just before each part, avoiding expiry of a batch during slow mobile PUTs.
  for (let number = parts.length + 1; number <= count; number++) {
    signal?.throwIfAborted();
    const signed = tickets(
      await options.signParts([number], signal),
      [number],
      scope,
      Date.now(),
    ).parts[0]!;
    signal?.throwIfAborted();
    const url = signedPut(
      signed.put_url,
      signed.expires_at,
      scope,
      number,
      session.post_id,
    );
    // Store only a digest binding a checkpoint to the provider session/key.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${url.pathname}?${url.searchParams.get("uploadId")}`,
      ),
    );
    const key = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (identity !== undefined && identity !== key)
      throw new ApiFailure("INTERNAL_ERROR");
    identity = key;
    const etag = await put(
      url,
      blob.slice((number - 1) * size, Math.min(number * size, blob.size)),
      {},
      true,
    );
    const part = { part_number: number, etag: etag! };
    parts.push(part);
    await options.onPart?.({ ...part }, identity);
    signal?.throwIfAborted();
  }
  return completion({ upload_id: session.upload_id, parts });
}
