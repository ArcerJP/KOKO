import { errors, type ErrorCode } from "@koko/contract";
import { ApiFailure } from "./client";
import {
  assertDestination,
  completion,
  partNumbers,
  receipt,
  record,
  ticket,
  tickets,
  uploadRequest,
  validId,
  type CompleteUpload,
  type UploadDestination,
  type UploadRequest,
} from "./upload-contract";

/** Explicit operations only; no retry, credential persistence or arbitrary endpoint. */
export function createUploadClient(
  baseUrl: URL,
  destination: UploadDestination,
  fetcher: typeof fetch = fetch,
) {
  assertDestination(destination);
  const scope = { ...destination, eventId: destination.eventId.toLowerCase() };
  const base = new URL(baseUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !base.pathname.endsWith("/") ||
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      ))
  )
    throw new TypeError("API設定が不正です。");
  function sameOrigin() {
    if (
      typeof globalThis.location !== "undefined" &&
      globalThis.location.origin !== base.origin
    )
      throw new TypeError("同一originのAPI設定が必要です。");
  }
  sameOrigin();
  async function post(
    path: string,
    value: unknown,
    csrf: string,
    status: number,
    maximum: number,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    sameOrigin();
    if (!/^[\x21-\x7e]{32,256}$/.test(csrf)) throw new ApiFailure("FORBIDDEN");
    const body = value === undefined ? undefined : JSON.stringify(value);
    if (body && new TextEncoder().encode(body).length > maximum)
      throw new ApiFailure("INVALID_INPUT");
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "X-Event-ID": scope.eventId,
          "X-CSRF-Token": csrf,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        mode: "same-origin",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        ...(body ? { body } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch {
      signal?.throwIfAborted();
      throw new ApiFailure("NETWORK_UNAVAILABLE");
    }
    let result: unknown;
    try {
      if (
        response.redirected ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        throw new Error();
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const cancel = () => void reader.cancel().catch(() => {});
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let text = "",
          size = 0;
        for (;;) {
          signal?.throwIfAborted();
          const chunk = await reader.read();
          signal?.throwIfAborted();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 1024 * 1024) throw new Error();
          text += decoder.decode(chunk.value, { stream: true });
        }
        result = JSON.parse(text + decoder.decode());
      } catch (error) {
        cancel();
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    } catch {
      void response.body?.cancel().catch(() => {});
      signal?.throwIfAborted();
      throw new ApiFailure("INTERNAL_ERROR");
    }
    if (response.status === status) return result;
    if (
      !response.ok &&
      record(result) &&
      typeof result.code === "string" &&
      Object.hasOwn(errors, result.code) &&
      errors[result.code as ErrorCode].status === response.status &&
      validId(result.request_id)
    )
      throw new ApiFailure(result.code as ErrorCode, result.request_id);
    throw new ApiFailure("INTERNAL_ERROR");
  }
  const id = (value: string) => {
    if (!validId(value)) throw new ApiFailure("INVALID_INPUT");
    return value.toLowerCase();
  };
  return {
    async open(input: UploadRequest, csrf: string, signal?: AbortSignal) {
      const normalized = uploadRequest(input);
      const result = ticket(
        await post("uploads", normalized, csrf, 200, 4096, signal),
        scope,
        Date.now(),
      );
      if (
        result.mode === "single" &&
        result.required_headers?.["content-type"] !== normalized.content_type
      )
        throw new ApiFailure("INTERNAL_ERROR");
      return result;
    },
    async refresh(uploadId: string, csrf: string, signal?: AbortSignal) {
      const expected = id(uploadId);
      const result = ticket(
        await post(
          `uploads/${expected}/refresh`,
          undefined,
          csrf,
          200,
          0,
          signal,
        ),
        scope,
        Date.now(),
      );
      if (result.upload_id !== expected) throw new ApiFailure("INTERNAL_ERROR");
      return result;
    },
    async parts(
      uploadId: string,
      numbers: number[],
      csrf: string,
      signal?: AbortSignal,
    ) {
      const selected = partNumbers(numbers);
      return tickets(
        await post(
          `uploads/${id(uploadId)}/parts`,
          { part_numbers: selected },
          csrf,
          200,
          4096,
          signal,
        ),
        selected,
        scope,
        Date.now(),
      );
    },
    async complete(
      postId: string,
      input: CompleteUpload,
      csrf: string,
      signal?: AbortSignal,
    ) {
      const expected = id(postId);
      return receipt(
        await post(
          `posts/${expected}/complete`,
          completion(input),
          csrf,
          202,
          1024 * 1024,
          signal,
        ),
        expected,
        scope.eventId,
      );
    },
  };
}
