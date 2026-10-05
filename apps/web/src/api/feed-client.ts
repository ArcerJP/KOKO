import { errors, type ErrorCode } from "@koko/contract";
import { ApiFailure } from "./client";
import { validId, record } from "./upload-contract";
import {
  feedSearch,
  parseFeedPage,
  parsePublicPost,
  type FeedQuery,
} from "./feed-contract";

export function createFeedClient(
  baseUrl: URL,
  eventId: string,
  fetcher: typeof fetch = fetch,
) {
  const base = new URL(baseUrl);
  if (
    !validId(eventId) ||
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
    throw new Error("INVALID_FEED_CONFIG");
  async function get(path: string, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (typeof location !== "undefined" && location.origin !== base.origin)
      throw new ApiFailure("FORBIDDEN");
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method: "GET",
        mode: "same-origin",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { accept: "application/json", "x-event-id": eventId },
        ...(signal ? { signal } : {}),
      });
    } catch {
      signal?.throwIfAborted();
      throw new ApiFailure("NETWORK_UNAVAILABLE");
    }
    if (
      response.redirected ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        response.headers.get("content-type") ?? "",
      ) ||
      !response.body
    ) {
      void response.body?.cancel().catch(() => {});
      throw new ApiFailure("INTERNAL_ERROR");
    }
    const reader = response.body.getReader(),
      cancel = () => {
        void reader.cancel().catch(() => {});
      };
    signal?.addEventListener("abort", cancel, { once: true });
    let value: unknown;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "",
        length = 0;
      for (;;) {
        signal?.throwIfAborted();
        const part = await reader.read();
        signal?.throwIfAborted();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 262144) throw new Error();
        text += decoder.decode(part.value, { stream: true });
      }
      value = JSON.parse(text + decoder.decode());
    } catch {
      signal?.throwIfAborted();
      throw new ApiFailure("INTERNAL_ERROR");
    } finally {
      signal?.removeEventListener("abort", cancel);
      cancel();
    }
    if (response.status === 200) return value;
    if (
      record(value) &&
      typeof value.code === "string" &&
      Object.hasOwn(errors, value.code) &&
      validId(value.request_id) &&
      errors[value.code as ErrorCode].status === response.status
    )
      throw new ApiFailure(value.code as ErrorCode, value.request_id);
    throw new ApiFailure("INTERNAL_ERROR");
  }
  return {
    async list(query: FeedQuery = {}, signal?: AbortSignal) {
      const search = feedSearch(query);
      if (search === null) throw new ApiFailure("INVALID_INPUT");
      const result = parseFeedPage(
        await get(`feed${search}`, signal),
        eventId,
        query,
      );
      if (!result) throw new ApiFailure("INTERNAL_ERROR");
      return result;
    },
    async post(id: string, signal?: AbortSignal) {
      if (!validId(id)) throw new ApiFailure("INVALID_INPUT");
      const result = parsePublicPost(
        await get(`posts/${id.toLowerCase()}`, signal),
        eventId,
        id.toLowerCase(),
      );
      if (!result) throw new ApiFailure("INTERNAL_ERROR");
      return result;
    },
  };
}
