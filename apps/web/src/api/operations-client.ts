import { errors, type ErrorCode } from "@koko/contract";
import { ApiFailure } from "./client";
import { record, validId } from "./upload-contract";
import {
  operationInput,
  operationResponse,
  operationRoute,
  type Operation,
  type OperationResponse,
} from "./operations-contract";

export function operationPayload(result: OperationResponse): unknown {
  switch (result.kind) {
    case "settings":
      return result.settings;
    case "themes":
      return { items: result.items };
    case "posts":
    case "appeals":
      return { items: result.items, next_cursor: result.next_cursor };
    case "ack":
      return {
        request_id: result.request_id,
        ...(result.resource_id ? { resource_id: result.resource_id } : {}),
      };
  }
}

export function createOperationsClient(
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
    throw new Error("INVALID_OPERATIONS_CONFIG");
  return {
    async execute(
      op: Operation,
      input?: unknown,
      csrf?: string,
      signal?: AbortSignal,
    ): Promise<OperationResponse> {
      signal?.throwIfAborted();
      if (typeof location !== "undefined" && location.origin !== base.origin)
        throw new ApiFailure("FORBIDDEN");
      const route = operationRoute(op);
      if (
        route.mutation &&
        (typeof csrf !== "string" || !/^[\x21-\x7e]{32,256}$/.test(csrf))
      )
        throw new ApiFailure("FORBIDDEN");
      const body = route.mutation
        ? JSON.stringify(operationInput(op, input))
        : undefined;
      if (
        body !== undefined &&
        new TextEncoder().encode(body).byteLength > 32768
      )
        throw new ApiFailure("INVALID_INPUT");
      let response: Response;
      try {
        response = await fetcher(new URL(route.path + route.search, base), {
          method: route.method,
          mode: "same-origin",
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          headers: {
            accept: "application/json",
            "x-event-id": eventId,
            ...(route.mutation
              ? { "content-type": "application/json", "x-csrf-token": csrf! }
              : {}),
          },
          ...(body === undefined ? {} : { body }),
          ...(signal ? { signal } : {}),
        });
      } catch {
        signal?.throwIfAborted();
        throw new ApiFailure("NETWORK_UNAVAILABLE");
      }
      signal?.throwIfAborted();
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
      const reader = response.body.getReader();
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal?.addEventListener("abort", cancel, { once: true });
      let result: unknown;
      try {
        let length = 0,
          text = "";
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for (;;) {
          signal?.throwIfAborted();
          const part = await reader.read();
          signal?.throwIfAborted();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 262144) throw new ApiFailure("INTERNAL_ERROR");
          text += decoder.decode(part.value, { stream: true });
        }
        result = JSON.parse(text + decoder.decode());
      } catch {
        signal?.throwIfAborted();
        throw new ApiFailure("INTERNAL_ERROR");
      } finally {
        signal?.removeEventListener("abort", cancel);
        cancel();
      }
      if (response.status === 200)
        return operationResponse(op, result, eventId);
      if (
        record(result) &&
        typeof result.code === "string" &&
        Object.hasOwn(errors, result.code) &&
        validId(result.request_id) &&
        errors[result.code as ErrorCode].status === response.status
      )
        throw new ApiFailure(result.code as ErrorCode, result.request_id);
      throw new ApiFailure("INTERNAL_ERROR");
    },
  };
}
